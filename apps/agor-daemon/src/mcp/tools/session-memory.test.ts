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
});
