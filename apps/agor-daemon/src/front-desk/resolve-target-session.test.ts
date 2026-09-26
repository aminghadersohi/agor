/**
 * Unit tests for the parts of the shared resolver that never touch a
 * database. The front-desk slot, health gate, and recency fallback are proven
 * against real SQLite and PostgreSQL in `front-desk.{integration,postgres}.test.ts`.
 */

import type { BranchID, GatewayChannelID, SessionID, UserID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  frontDeskScopeKey,
  isExecutorLifecycleFailure,
  type ResolveTargetSessionDeps,
  resolveTargetSession,
} from './resolve-target-session';

function untouchedDeps(): ResolveTargetSessionDeps {
  return {
    read: vi.fn(async () => {
      throw new Error('read must not be called');
    }),
    write: vi.fn(async () => {
      throw new Error('write must not be called');
    }),
    mostRecentSession: vi.fn(async () => {
      throw new Error('recency must not be consulted');
    }),
  };
}

const input = {
  branchId: 'branch-1' as BranchID,
  callerUserId: 'user-1' as UserID,
};

describe('resolveTargetSession', () => {
  it('returns an explicitly named session without consulting a front desk or recency', async () => {
    const deps = untouchedDeps();
    await expect(
      resolveTargetSession(
        { ...input, scope: { kind: 'teammate' }, explicitSessionId: 'sess-1' as SessionID },
        deps
      )
    ).resolves.toEqual({ via: 'explicit', sessionId: 'sess-1' });
    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.mostRecentSession).not.toHaveBeenCalled();
  });

  it('refuses gateway scope until thread-mapping precedence ships with its caller', async () => {
    await expect(
      resolveTargetSession(
        {
          ...input,
          scope: { kind: 'gateway', channelId: 'chan-1' as GatewayChannelID, threadId: 't-1' },
        },
        untouchedDeps()
      )
    ).rejects.toThrow(/not enabled/);
  });
});

describe('frontDeskScopeKey', () => {
  it('maps each scope onto its persisted discriminator', () => {
    expect(frontDeskScopeKey({ kind: 'teammate' })).toBe('teammate');
    expect(
      frontDeskScopeKey({ kind: 'gateway', channelId: 'chan-1' as GatewayChannelID, threadId: 't' })
    ).toBe('gateway:chan-1');
  });
});

describe('isExecutorLifecycleFailure', () => {
  it('counts only supervised executor death, not an agent error or a user stop', () => {
    const sdk_failure = {
      reason: 'heartbeat_lost' as const,
      detected_at: '2026-01-01T00:00:00.000Z',
      tool: 'claude-code' as const,
      termination: 'verified' as const,
    };
    expect(isExecutorLifecycleFailure({ status: 'failed', sdk_failure })).toBe(true);
    expect(isExecutorLifecycleFailure({ status: 'failed', sdk_failure: undefined })).toBe(false);
    expect(isExecutorLifecycleFailure({ status: 'completed', sdk_failure: undefined })).toBe(false);
    expect(isExecutorLifecycleFailure({ status: 'stopped', sdk_failure })).toBe(false);
  });
});
