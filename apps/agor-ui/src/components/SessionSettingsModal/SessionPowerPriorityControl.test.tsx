import type { AgorClient, SessionID, SessionPowerPriorityView } from '@agor-live/client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPowerPriorityControl } from './SessionPowerPriorityControl';

const showError = vi.fn();
const showSuccess = vi.fn();
vi.mock('../../utils/message', () => ({
  useThemedMessage: () => ({ showError, showSuccess }),
}));

const sessionId = '018f0000-0000-7000-8000-000000000001' as SessionID;

function view(requested: 'normal' | 'essential'): SessionPowerPriorityView {
  return {
    session_id: sessionId,
    requested,
    effective: requested === 'essential',
    can_manage: true,
    max_essential_sessions: 1,
  };
}

describe('SessionPowerPriorityControl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reloads both mounted tabs from the canonical Session realtime event', async () => {
    let current = view('normal');
    const listeners = new Set<(session: { session_id?: string }) => void>();
    const priorityService = {
      find: vi.fn(async () => current),
      create: vi.fn(async () => current),
    };
    const sessionsService = {
      on: vi.fn((_event: string, listener: (session: { session_id?: string }) => void) => {
        listeners.add(listener);
      }),
      off: vi.fn((_event: string, listener: (session: { session_id?: string }) => void) => {
        listeners.delete(listener);
      }),
    };
    const client = {
      service: (path: string) => (path === 'sessions' ? sessionsService : priorityService),
    } as unknown as AgorClient;

    const first = render(<SessionPowerPriorityControl client={client} sessionId={sessionId} />);
    const second = render(<SessionPowerPriorityControl client={client} sessionId={sessionId} />);
    await waitFor(() => expect(screen.getAllByText('Effective: Normal')).toHaveLength(2));

    current = view('essential');
    await act(async () => {
      for (const listener of listeners) listener({ session_id: sessionId });
    });
    await waitFor(() => expect(screen.getAllByText('Effective: Essential')).toHaveLength(2));
    expect(priorityService.find).toHaveBeenCalledTimes(4);

    first.unmount();
    second.unmount();
    expect(listeners).toHaveLength(0);
  });
});
