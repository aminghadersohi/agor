import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { AGOR_RUNTIME_SOURCE } from './agor-runtime-source';

type Listener = (event: { source: unknown; data: unknown }) => void;

/** Run the injected runtime against a stub iframe window. */
function installRuntime() {
  const listeners: Listener[] = [];
  const parent = { postMessage: vi.fn() };
  const win: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'message') listeners.push(fn);
    },
  };
  vm.runInNewContext(AGOR_RUNTIME_SOURCE, {
    window: win,
    document: {},
    setTimeout,
    clearTimeout,
  });
  const agor = win.agor as {
    runAction(id: string): Promise<unknown>;
    fetchData(id: string): Promise<unknown>;
    openChat(id: string): Promise<unknown>;
  };
  const deliver = (source: unknown, data: unknown) => {
    for (const listener of listeners) listener({ source, data });
  };
  return { agor, parent, deliver };
}

describe('agor-runtime window.agor bindings', () => {
  it('sends only the binding id to the parent and resolves with its reply', async () => {
    const { agor, parent, deliver } = installRuntime();

    const pending = agor.runAction('run-now');
    const sent = parent.postMessage.mock.calls.find(
      ([message]) => (message as { type?: string }).type === 'agor:run-action'
    )?.[0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['actionId', 'requestId', 'type']);
    expect(sent.actionId).toBe('run-now');

    // A reply from anything but the parent window is ignored.
    deliver({}, { type: 'agor:interaction-result', requestId: sent.requestId, ok: true });
    deliver(parent, {
      type: 'agor:interaction-result',
      requestId: sent.requestId,
      ok: true,
      result: { effect: 'schedule_run' },
    });
    await expect(pending).resolves.toEqual({ effect: 'schedule_run' });
  });

  it('rejects with the parent error for reads and chats', async () => {
    const { agor, parent, deliver } = installRuntime();

    const read = agor.fetchData('nightly');
    const chat = agor.openChat('triage');
    const [readMsg, chatMsg] = parent.postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter((message) => message.type !== 'agor:ready');
    expect(readMsg).toMatchObject({ type: 'agor:fetch-data', dataId: 'nightly' });
    expect(chatMsg).toMatchObject({ type: 'agor:open-chat', chatId: 'triage' });

    deliver(parent, {
      type: 'agor:interaction-result',
      requestId: readMsg.requestId,
      ok: false,
      error: 'Forbidden',
    });
    deliver(parent, {
      type: 'agor:interaction-result',
      requestId: chatMsg.requestId,
      ok: false,
      error: 'No chat is configured',
    });
    await expect(read).rejects.toThrow('Forbidden');
    await expect(chat).rejects.toThrow('No chat is configured');
  });

  it('refuses a call without a binding id', async () => {
    const { agor } = installRuntime();
    await expect(agor.runAction('')).rejects.toThrow('A binding id is required');
  });
});
