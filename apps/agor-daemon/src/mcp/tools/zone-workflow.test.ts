import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { registerZoneWorkflowTools } from './zone-workflow.js';

describe('zone workflow MCP tools', () => {
  it('resolves board aliases and routes create through the authenticated Feathers service', async () => {
    const create = vi.fn(async (data, params) => ({
      transition_id: 'transition-1',
      ...data,
      params,
    }));
    const getBoard = vi.fn(async () => ({ board_id: '00000000-0000-7000-8000-000000000010' }));
    let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
    const server = {
      registerTool(name: string, _config: unknown, callback: typeof handler) {
        if (name === 'agor_zone_workflow_transitions_create') handler = callback;
      },
    } as unknown as McpServer;
    const baseServiceParams = { provider: 'mcp', authenticated: true };
    registerZoneWorkflowTools(server, {
      app: {
        service(name: string) {
          if (name === 'boards') return { get: getBoard };
          if (name === 'zone-workflow-transitions') return { create };
          throw new Error(`Unexpected service: ${name}`);
        },
      },
      db: {},
      userId: '00000000-0000-7000-8000-000000000001',
      authenticatedUser: {
        user_id: '00000000-0000-7000-8000-000000000001',
        role: 'member',
      },
      baseServiceParams,
    } as never);

    expect(handler).toBeDefined();
    await handler?.({
      boardId: 'planning',
      sourceZoneId: 'todo',
      targetZoneId: 'done',
      label: 'Complete',
    });
    expect(getBoard).toHaveBeenCalledWith('planning', expect.anything());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        board_id: '00000000-0000-7000-8000-000000000010',
        source_zone_id: 'todo',
        target_zone_id: 'done',
        label: 'Complete',
      }),
      baseServiceParams
    );
  });
});
