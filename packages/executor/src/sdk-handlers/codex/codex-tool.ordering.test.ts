import type { Message } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { MessagesRepository, SessionRepository } from '../../db/feathers-repositories.js';
import type { MessagesService } from '../base/index.js';
import { CodexTool } from './codex-tool.js';
import type { CodexStreamEvent } from './prompt-service.js';

vi.mock('../base/diff-enrichment.js', () => ({
  clearEditFilesTurnBaseline: vi.fn(),
  clearToolInvocationState: vi.fn(),
  enrichContentBlocks: vi.fn(),
  refreshEditFilesTurnBaseline: vi.fn(),
  registerEditFilesTurnBaseline: vi.fn(),
  registerToolInvocationStart: vi.fn(),
}));

vi.mock('./prompt-service.js', () => ({
  CodexPromptService: class {},
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for provider persistence boundary');
}

describe('CodexTool ordered transcript persistence', () => {
  it('rejects a lost tool-output acknowledgement without replay or silent successful completion', async () => {
    let providerClosed = false;
    const create = vi.fn(async (data: Partial<Message>) => data as Message);
    const patch = vi.fn().mockRejectedValue(new Error('socket has been disconnected'));
    const tool = new CodexTool(
      {
        findInitialUserMessagesByTaskId: vi.fn().mockResolvedValue([]),
        getNextIndexBySessionId: vi.fn().mockResolvedValue(0),
      } as unknown as MessagesRepository,
      { findById: vi.fn().mockResolvedValue(null) } as unknown as SessionRepository,
      undefined,
      undefined,
      undefined,
      undefined,
      { create, patch }
    );
    const promptService = {
      async *promptSessionStreaming(): AsyncGenerator<CodexStreamEvent> {
        try {
          yield { type: 'tool_start', toolUse: { id: 'tool-1', name: 'WebSearch', input: {} } };
          yield {
            type: 'tool_complete',
            toolUse: {
              id: 'tool-1',
              name: 'WebSearch',
              input: {},
              output: 'Durable output required',
              status: 'completed',
            },
          };
          yield {
            type: 'complete',
            threadId: '',
            content: [{ type: 'text', text: 'must not be reported as persisted' }],
          };
        } finally {
          providerClosed = true;
        }
      },
    };
    (tool as unknown as { promptService: typeof promptService }).promptService = promptService;
    await expect(
      tool.executePromptWithStreaming(
        '018f0000-0000-7000-8000-000000000001' as never,
        'prompt',
        '018f0000-0000-7000-8000-000000000002' as never
      )
    ).rejects.toThrow('socket has been disconnected');
    expect(patch).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2); // user + tool start, never a false final response
    expect(providerClosed).toBe(true);
  });

  it('awaits concurrent tool acknowledgements in provider event order before the final response', async () => {
    const order: string[] = [];
    const firstToolStartAcknowledgement = deferred<Message>();
    const secondToolStartAcknowledgement = deferred<Message>();
    const secondToolResultAcknowledgement = deferred<Message>();
    const firstToolResultAcknowledgement = deferred<Message>();
    let createCount = 0;
    const messagesService: MessagesService = {
      create: vi.fn(async (data: Partial<Message>) => {
        createCount += 1;
        const content = Array.isArray(data.content) ? data.content : [];
        if (createCount === 1) {
          order.push('create:user:0');
          return data as Message;
        }
        const toolUse = content.find((block) => block.type === 'tool_use');
        if (toolUse) {
          const id = String(toolUse.id);
          order.push(`create:${id}:${data.index}`);
          return id === 'tool-1'
            ? firstToolStartAcknowledgement.promise
            : secondToolStartAcknowledgement.promise;
        }
        order.push(`create:assistant:${data.index}`);
        return data as Message;
      }),
      patch: vi.fn(async (_id: string, data: Partial<Message>) => {
        const content = Array.isArray(data.content) ? data.content : [];
        const result = content.find((block) => block.type === 'tool_result');
        const id = String(result?.tool_use_id);
        order.push(`patch:${id}`);
        return (
          id === 'tool-1'
            ? firstToolResultAcknowledgement.promise
            : secondToolResultAcknowledgement.promise
        ).then(() => data as Message);
      }),
    };
    const messagesRepo = {
      findInitialUserMessagesByTaskId: vi.fn().mockResolvedValue([]),
      getNextIndexBySessionId: vi.fn().mockResolvedValue(0),
    } as unknown as MessagesRepository;
    const sessionsRepo = {
      findById: vi.fn().mockResolvedValue(null),
    } as unknown as SessionRepository;
    const tool = new CodexTool(
      messagesRepo,
      sessionsRepo,
      undefined,
      undefined,
      undefined,
      undefined,
      messagesService
    );
    const events: CodexStreamEvent[] = [
      {
        type: 'tool_start',
        toolUse: { id: 'tool-1', name: 'WebSearch', input: { query: 'agor' } },
      },
      {
        type: 'tool_start',
        toolUse: { id: 'tool-2', name: 'WebSearch', input: { query: 'socket.io' } },
      },
      {
        type: 'tool_complete',
        toolUse: {
          id: 'tool-2',
          name: 'WebSearch',
          input: { query: 'socket.io' },
          output: 'second projected tool output',
          status: 'completed',
        },
      },
      {
        type: 'tool_complete',
        toolUse: {
          id: 'tool-1',
          name: 'WebSearch',
          input: { query: 'agor' },
          output: 'first projected tool output',
          status: 'completed',
        },
      },
      {
        type: 'complete',
        threadId: '',
        content: [{ type: 'text', text: 'final response' }],
      },
    ];
    const promptService = {
      async *promptSessionStreaming() {
        yield* events;
      },
    };
    (tool as unknown as { promptService: typeof promptService }).promptService = promptService;

    const execution = tool.executePromptWithStreaming(
      '018f0000-0000-7000-8000-000000000001' as never,
      'prompt',
      '018f0000-0000-7000-8000-000000000002' as never
    );

    await waitFor(() => order.includes('create:tool-1:1'));
    expect(order).toEqual(['create:user:0', 'create:tool-1:1']);
    firstToolStartAcknowledgement.resolve({} as Message);

    await waitFor(() => order.includes('create:tool-2:2'));
    expect(order).toEqual(['create:user:0', 'create:tool-1:1', 'create:tool-2:2']);
    secondToolStartAcknowledgement.resolve({} as Message);

    await waitFor(() => order.includes('patch:tool-2'));
    expect(order).toEqual(['create:user:0', 'create:tool-1:1', 'create:tool-2:2', 'patch:tool-2']);
    secondToolResultAcknowledgement.resolve({} as Message);

    await waitFor(() => order.includes('patch:tool-1'));
    expect(order).toEqual([
      'create:user:0',
      'create:tool-1:1',
      'create:tool-2:2',
      'patch:tool-2',
      'patch:tool-1',
    ]);
    firstToolResultAcknowledgement.resolve({} as Message);

    await execution;
    expect(order).toEqual([
      'create:user:0',
      'create:tool-1:1',
      'create:tool-2:2',
      'patch:tool-2',
      'patch:tool-1',
      'create:assistant:3',
    ]);
  });
});
