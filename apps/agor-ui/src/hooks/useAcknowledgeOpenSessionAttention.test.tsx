import type { AgorClient, Session } from '@agor-live/client';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../store/agorStore';
import { useAcknowledgeOpenSessionAttention } from './useAcknowledgeOpenSessionAttention';

const makeSession = (generation: number, seen: number): Session =>
  ({
    session_id: 'session-open',
    branch_id: 'branch-open',
    status: 'idle',
    ready_for_prompt: true,
    attention_generation: generation,
    viewer_seen_attention_generation: seen,
    archived: false,
    created_at: '2026-08-30T00:00:00.000Z',
    last_updated: '2026-08-30T00:00:00.000Z',
  }) as unknown as Session;

function seedSession(session: Session): void {
  agorStore.setState({
    sessionById: new Map([[session.session_id, session]]),
    sessionsByBranch: new Map([[session.branch_id, [session]]]),
  });
}

beforeEach(() => agorStore.getState().reset());
afterEach(() => agorStore.getState().reset());

describe('useAcknowledgeOpenSessionAttention', () => {
  it('acknowledges an open unseen session and clears only its caller-private signal', async () => {
    const session = makeSession(3, 1);
    seedSession(session);
    const acknowledgeAttention = vi.fn(async () => ({
      session_id: session.session_id,
      attention_generation: 3,
      seen_attention_generation: 3,
    }));
    const client = { sessions: { acknowledgeAttention } } as unknown as AgorClient;

    renderHook(() => useAcknowledgeOpenSessionAttention(client, session));

    await waitFor(() => expect(acknowledgeAttention).toHaveBeenCalledWith(session.session_id));
    await waitFor(() =>
      expect(agorStore.getState().sessionById.get(session.session_id)).toMatchObject({
        ready_for_prompt: true,
        attention_generation: 3,
        viewer_seen_attention_generation: 3,
      })
    );
  });

  it('acknowledges a new result that arrives while the session remains open', async () => {
    const first = makeSession(1, 1);
    seedSession(first);
    const acknowledgeAttention = vi.fn(async () => ({
      session_id: first.session_id,
      attention_generation: 2,
      seen_attention_generation: 2,
    }));
    const client = { sessions: { acknowledgeAttention } } as unknown as AgorClient;
    const { rerender } = renderHook(
      ({ session }) => useAcknowledgeOpenSessionAttention(client, session),
      { initialProps: { session: first } }
    );
    expect(acknowledgeAttention).not.toHaveBeenCalled();

    const next = makeSession(2, 1);
    seedSession(next);
    rerender({ session: next });

    await waitFor(() => expect(acknowledgeAttention).toHaveBeenCalledOnce());
    expect(agorStore.getState().sessionById.get(first.session_id)).toMatchObject({
      viewer_seen_attention_generation: 2,
    });
  });
});
