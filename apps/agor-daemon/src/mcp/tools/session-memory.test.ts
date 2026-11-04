import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { McpContext } from '../server';
import { registerSessionMemoryTools } from './session-memory';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function fixture(sessionId?: string) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, { inputSchema?: unknown }>();
  const memories = { create: vi.fn(async (data) => data), find: vi.fn(), patch: vi.fn() };
  const reminders = { create: vi.fn(async (data) => data), find: vi.fn(), patch: vi.fn() };
  const server = {
    registerTool(name: string, config: { inputSchema?: unknown }, handler: Handler) {
      configs.set(name, config);
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  const ctx = {
    app: {
      service(path: string) {
        return path === 'session-memories' ? memories : reminders;
      },
    },
    sessionId,
    authenticatedSession: sessionId ? { session_id: sessionId } : undefined,
    baseServiceParams: { provider: 'mcp' },
  } as unknown as McpContext;
  registerSessionMemoryTools(server, ctx);
  return { handlers, configs, memories, reminders };
}

describe('Session self-memory MCP tools', () => {
  it('registers only current-Session inputs, never a target Session field', () => {
    const { configs } = fixture('019f0000-0000-7000-8000-000000000001');
    expect([...configs]).toHaveLength(9);
    for (const config of configs.values()) {
      expect(JSON.stringify(config.inputSchema)).not.toMatch(/sessionId|session_id/);
    }
  });

  it('derives memory and reminder ownership from authenticated invocation context', async () => {
    const sessionId = '019f0000-0000-7000-8000-000000000001';
    const { handlers, memories, reminders } = fixture(sessionId);
    await handlers.get('agor_session_memory_create')?.({
      text: 'Fictional decision',
      sessionId: '019f0000-0000-7000-8000-000000000099',
    });
    await handlers.get('agor_session_reminders_create')?.({
      text: 'Review it',
      dueAtUtc: '2026-09-10T15:00:00Z',
      displayTimezone: 'America/New_York',
    });
    expect(memories.create).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: sessionId }),
      { provider: 'mcp' }
    );
    expect(reminders.create).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: sessionId }),
      { provider: 'mcp' }
    );
  });

  it('refuses self operations without an authenticated current Session', async () => {
    const { handlers, memories } = fixture();
    const result = (await handlers.get('agor_session_memory_create')?.({
      text: 'Should not be stored',
    })) as { content: Array<{ text: string }> };
    expect(memories.create).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toMatch(/session context/i);
  });

  it('passes an optional PR wake condition and validates its cadence', async () => {
    const sessionId = '019f0000-0000-7000-8000-000000000001';
    const { handlers, configs, reminders } = fixture(sessionId);
    const wakeWhen = { kind: 'github_pr', repo: 'acme/widgets', number: 284, state: 'merged' };
    await handlers.get('agor_session_reminders_create')?.({
      text: 'Tell River it merged',
      dueAtUtc: '2026-11-05T15:00:00Z',
      displayTimezone: 'UTC',
      wakeWhen,
      checkEveryMinutes: 15,
    });
    expect(reminders.create).toHaveBeenCalledWith(
      expect.objectContaining({ wake_when: wakeWhen, check_every_minutes: 15 }),
      { provider: 'mcp' }
    );

    const schema = (name: string) =>
      configs.get(name)?.inputSchema as { safeParse(value: unknown): { success: boolean } };
    const base = { text: 'x', dueAtUtc: '2026-11-05T15:00:00Z', displayTimezone: 'UTC' };
    const create = schema('agor_session_reminders_create');
    expect(create.safeParse(base).success).toBe(true);
    expect(create.safeParse({ ...base, wakeWhen }).success).toBe(true);
    expect(create.safeParse({ ...base, wakeWhen, checkEveryMinutes: 4 }).success).toBe(false);
    expect(create.safeParse({ ...base, wakeWhen, checkEveryMinutes: 61 }).success).toBe(false);
    expect(
      create.safeParse({ ...base, wakeWhen: { ...wakeWhen, state: 'approved' } }).success
    ).toBe(false);
    expect(create.safeParse({ ...base, wakeWhen: { ...wakeWhen, kind: 'issue' } }).success).toBe(
      false
    );
    const update = schema('agor_session_reminders_update');
    const id = { reminderId: '019f0000-0000-7000-8000-000000000002', expectedRevision: 1 };
    expect(update.safeParse({ ...id, wakeWhen: null }).success).toBe(true);
  });

  it('tells agents to keep follow-up promises with a reminder', () => {
    const { configs } = fixture('019f0000-0000-7000-8000-000000000001');
    const description = (configs.get('agor_session_reminders_create') as { description?: string })
      .description;
    expect(description).toContain('if you tell someone you will follow up when something happens');
    expect(description).toContain('before ending your turn');
  });
});
