import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { McpContext } from '../server.js';
import { POWER_HOLD_NOTE, registerPowerTools, resolvePromptPowerHold } from './power.js';

const heldAdmission = {
  held: true,
  state: 'conserve',
  reason: 'on_battery',
  transitioned_at: '2026-09-27T00:00:00.000Z',
};

function makeCtx(services: Record<string, Record<string, unknown>>, role = 'member'): McpContext {
  return {
    app: {
      service: (name: string) => {
        const svc = services[name];
        if (!svc) throw new Error(`Unexpected service call: ${name}`);
        return svc;
      },
    },
    db: {},
    userId: 'user-1',
    authenticatedUser: { user_id: 'user-1', role },
    baseServiceParams: { provider: 'mcp' },
  } as unknown as McpContext;
}

function captureStatusTool(ctx: McpContext) {
  let handler:
    | ((args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>)
    | null = null;
  let config: { annotations?: { readOnlyHint?: boolean } } | null = null;
  registerPowerTools(
    {
      registerTool: (name: string, cfg: typeof config, cb: typeof handler) => {
        if (name === 'agor_power_status') {
          config = cfg;
          handler = cb;
        }
      },
    } as unknown as McpServer,
    ctx
  );
  if (!handler || !config) throw new Error('agor_power_status was not registered');
  return {
    handler: handler as NonNullable<typeof handler>,
    config: config as NonNullable<typeof config>,
  };
}

describe('resolvePromptPowerHold', () => {
  it('reports the hold the dispatch permit returned without reading more state', async () => {
    const ctx = makeCtx({});
    const hold = await resolvePromptPowerHold(
      ctx,
      {
        status: 'queued' as never,
        power_hold: { held: true, would_hold: true, state: 'critical', reason: 'low_battery' },
      },
      'session-1' as never
    );
    expect(hold).toEqual({
      held: true,
      state: 'critical',
      reason: 'low_battery',
      note: POWER_HOLD_NOTE,
    });
  });

  it('does not report a hold for work that already started', async () => {
    const find = vi.fn();
    const hold = await resolvePromptPowerHold(
      makeCtx({ 'power-management/admission': { find } }),
      { status: 'running' as never },
      'session-1' as never
    );
    expect(hold).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });

  it('reports a hold for a prompt queued behind active work while power is held', async () => {
    const hold = await resolvePromptPowerHold(
      makeCtx({
        'power-management/admission': { find: vi.fn(async () => heldAdmission) },
        sessions: { get: vi.fn(async () => ({ power_priority: 'normal' })) },
      }),
      { status: 'queued' as never },
      'session-1' as never
    );
    expect(hold).toMatchObject({ held: true, state: 'conserve', reason: 'on_battery' });
  });

  it('exempts the Essential session while conserving, like the dispatch decision', async () => {
    const hold = await resolvePromptPowerHold(
      makeCtx({
        'power-management/admission': { find: vi.fn(async () => heldAdmission) },
        sessions: { get: vi.fn(async () => ({ power_priority: 'essential' })) },
      }),
      { status: 'queued' as never },
      'session-1' as never
    );
    expect(hold).toBeUndefined();
  });

  it('never fails an already-admitted prompt when the projection is unreadable', async () => {
    const hold = await resolvePromptPowerHold(
      makeCtx({
        'power-management/admission': {
          find: vi.fn(async () => {
            throw new Error('boom');
          }),
        },
      }),
      { status: 'queued' as never },
      'session-1' as never
    );
    expect(hold).toBeUndefined();
  });
});

describe('agor_power_status', () => {
  it('is read-only and gives members only the redacted admission projection', async () => {
    const adminFind = vi.fn();
    const ctx = makeCtx({
      'power-management/admission': { find: vi.fn(async () => heldAdmission) },
      'power-management': { find: adminFind },
    });
    const { handler, config } = captureStatusTool(ctx);
    const result = JSON.parse((await handler({})).content[0]!.text);

    expect(config.annotations?.readOnlyHint).toBe(true);
    expect(adminFind).not.toHaveBeenCalled();
    expect(result).toEqual({ ...heldAdmission, note: POWER_HOLD_NOTE });
    expect(result).not.toHaveProperty('status');
  });

  it('gives admins the full status and derives admission from the same snapshot', async () => {
    const status = {
      mode: 'enforce',
      state: 'normal',
      reason: 'online',
      freshness: 'fresh',
      transitioned_at: '2026-09-27T00:00:00.000Z',
      would_hold: false,
      held: false,
      observation: {
        condition: 'online',
        communication: 'ok',
        observed_at: '2026-09-27T00:00:00.000Z',
        charge_percent: 100,
      },
    };
    const redactedFind = vi.fn();
    const ctx = makeCtx(
      {
        'power-management/admission': { find: redactedFind },
        'power-management': { find: vi.fn(async () => status) },
      },
      'admin'
    );
    const { handler } = captureStatusTool(ctx);
    const result = JSON.parse((await handler({})).content[0]!.text);

    expect(redactedFind).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      held: false,
      state: 'normal',
      reason: 'online',
      note: 'New work dispatches normally.',
      status,
    });
  });
});
