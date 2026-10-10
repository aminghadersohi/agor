import type { Session } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import type { AgorState } from '../../store/agorStore';
import { makeBoardSessionActivitySelector } from '../../store/selectors';
import { isSessionRowRead } from './sessionRowPresentation';

const settled = (overrides: Partial<Session>): Session =>
  ({
    session_id: 's1',
    branch_id: 'b1',
    status: 'idle',
    archived: false,
    // Settled sessions keep the shared flag after being opened.
    ready_for_prompt: true,
    attention_generation: 2,
    ...overrides,
  }) as Session;

describe('per-viewer session attention consumers', () => {
  it('keeps a row full strength only while this viewer has an unseen result', () => {
    expect(isSessionRowRead(settled({ viewer_seen_attention_generation: 1 }), false)).toBe(false);
    expect(isSessionRowRead(settled({ viewer_seen_attention_generation: 2 }), false)).toBe(true);
  });

  it('lights the board favicon for unseen results, not for the shared ready flag', () => {
    const state = (session: Session) =>
      ({
        boardObjectsByBoardId: new Map([['board', [{ branch_id: 'b1' }]]]),
        sessionsByBranch: new Map([['b1', [session]]]),
      }) as unknown as AgorState;
    const select = makeBoardSessionActivitySelector('board');

    expect(select(state(settled({ viewer_seen_attention_generation: 1 }))).hasReady).toBe(true);
    expect(select(state(settled({ viewer_seen_attention_generation: 2 }))).hasReady).toBe(false);
  });
});
