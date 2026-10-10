import {
  type AgorClient,
  isSessionPromptable,
  type Session,
  SessionStatus,
} from '@agor-live/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionMaps, EMPTY_MAPS } from '../store/agorMaps';
import { agorStore } from '../store/agorStore';
import { clearOpenedSessionFlags } from './sessionAttention';
import { canSessionStartTurn } from './sessionTurn';

afterEach(() => agorStore.getState().reset());

/**
 * Settles a session the way the daemon does, then opens it the way the UI does.
 * Fork: unread results are acknowledged per viewer, so opening never patches
 * the shared `ready_for_prompt` runtime-promptability flag.
 */
async function openedAfterSettling(status: Session['status']): Promise<Session> {
  let session = { session_id: 's1', status, ready_for_prompt: true } as Session;
  agorStore.setState({ ...EMPTY_MAPS, ...buildSessionMaps([session]) } as never);
  const patch = vi.fn(async (_id: string, data: Partial<Session>) => {
    session = { ...session, ...data };
  });
  clearOpenedSessionFlags({ service: () => ({ patch }) } as unknown as AgorClient, 's1');
  await Promise.resolve();
  expect(patch).not.toHaveBeenCalled();
  return session;
}

describe('canSessionStartTurn', () => {
  it.each([SessionStatus.FAILED, SessionStatus.IDLE, SessionStatus.TIMED_OUT])(
    'still allows a new turn after a %s session is opened',
    async (status) => {
      const opened = await openedAfterSettling(status);
      expect(opened.ready_for_prompt).toBe(true);
      expect(canSessionStartTurn(opened, 0)).toBe(true);
      expect(isSessionPromptable(opened)).toBe(true);
    }
  );

  it('offers no new turn on a timed-out session that is no longer promptable', () => {
    expect(
      canSessionStartTurn({ status: SessionStatus.TIMED_OUT, ready_for_prompt: false }, 0)
    ).toBe(false);
    expect(
      canSessionStartTurn({ status: SessionStatus.TIMED_OUT, ready_for_prompt: true }, 0)
    ).toBe(true);
  });

  it.each([
    SessionStatus.RUNNING,
    SessionStatus.STOPPING,
    SessionStatus.AWAITING_PERMISSION,
    SessionStatus.AWAITING_INPUT,
    SessionStatus.COMPLETED,
  ])('never starts a turn the drainer would not run while the session is %s', (status) => {
    expect(canSessionStartTurn({ status, ready_for_prompt: true }, 0)).toBe(false);
  });

  it('never jumps a queued prompt', () => {
    expect(canSessionStartTurn({ status: SessionStatus.IDLE, ready_for_prompt: true }, 1)).toBe(
      false
    );
  });
});
