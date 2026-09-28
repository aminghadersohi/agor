import type { AgorClient, Branch, SessionID, TeammateFrontDeskView } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTeammateFrontDesk } from './useTeammateFrontDesk';

const messages = vi.hoisted(() => ({
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
}));
vi.mock('../utils/message', () => ({ useThemedMessage: () => messages }));

const teammate = {
  branch_id: 'branch-1',
  archived: false,
  custom_context: { teammate: { kind: 'teammate', displayName: 'Front Desk' } },
} as unknown as Branch;
const plainBranch = { branch_id: 'branch-2', archived: false } as unknown as Branch;

const PINNED = 'session-pinned' as SessionID;
const OTHER = 'session-other' as SessionID;

function view(sessionId: SessionID | null, canManage = true): TeammateFrontDeskView {
  return {
    branch_id: teammate.branch_id,
    front_desk: sessionId
      ? ({
          session_id: sessionId,
          status: 'active',
          branch_id: teammate.branch_id,
        } as TeammateFrontDeskView['front_desk'])
      : null,
    can_manage: canManage,
  };
}

function clientWith(service: Record<string, ReturnType<typeof vi.fn>>) {
  const paths: string[] = [];
  const client = {
    service: (path: string) => {
      paths.push(path);
      return service;
    },
  } as unknown as AgorClient;
  return { client, paths };
}

describe('useTeammateFrontDesk', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not call the daemon for a branch that is not a teammate', () => {
    const find = vi.fn();
    const { client } = clientWith({ find });
    const { result } = renderHook(() => useTeammateFrontDesk(client, plainBranch));
    expect(result.current.view).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(find).not.toHaveBeenCalled();
  });

  it('loads the view from branches/:id/front-desk', async () => {
    const find = vi.fn(async () => view(PINNED, false));
    const { client, paths } = clientWith({ find });
    const { result } = renderHook(() => useTeammateFrontDesk(client, teammate));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.view).toEqual(view(PINNED, false)));
    expect(paths).toContain('branches/branch-1/front-desk');
  });

  it('pins with the loaded occupant as the compare-and-swap guard', async () => {
    const find = vi.fn(async () => view(PINNED));
    const create = vi.fn(async () => view(OTHER));
    const { client } = clientWith({ find, create });
    const { result } = renderHook(() => useTeammateFrontDesk(client, teammate));
    await waitFor(() => expect(result.current.view).not.toBeNull());

    await act(async () => {
      await expect(result.current.pin(OTHER)).resolves.toBe(true);
    });
    expect(create).toHaveBeenCalledWith({ session_id: OTHER, expected_session_id: PINNED });
    expect(result.current.view?.front_desk?.session_id).toBe(OTHER);
    expect(messages.showSuccess).toHaveBeenCalledWith('Pinned as front desk');
  });

  it('unpins with the occupant as the guard', async () => {
    const find = vi.fn(async () => view(PINNED));
    const remove = vi.fn(async () => view(null));
    const { client } = clientWith({ find, remove });
    const { result } = renderHook(() => useTeammateFrontDesk(client, teammate));
    await waitFor(() => expect(result.current.view).not.toBeNull());

    await act(async () => {
      await result.current.unpin();
    });
    expect(remove).toHaveBeenCalledWith(null, { query: { expected_session_id: PINNED } });
    expect(result.current.view?.front_desk).toBeNull();
  });

  it('reloads and warns when the desk changed underneath (409)', async () => {
    const find = vi.fn().mockResolvedValueOnce(view(null)).mockResolvedValueOnce(view(PINNED));
    const create = vi.fn(async () => {
      throw Object.assign(new Error('Front desk changed'), { code: 409 });
    });
    const { client } = clientWith({ find, create });
    const { result } = renderHook(() => useTeammateFrontDesk(client, teammate));
    await waitFor(() => expect(result.current.view).not.toBeNull());

    await act(async () => {
      await expect(result.current.pin(OTHER)).resolves.toBe(false);
    });
    expect(create).toHaveBeenCalledWith({ session_id: OTHER, expected_session_id: null });
    expect(messages.showWarning).toHaveBeenCalled();
    expect(messages.showError).not.toHaveBeenCalled();
    expect(result.current.view?.front_desk?.session_id).toBe(PINNED);
  });

  it('surfaces a refusal as an error without changing the view', async () => {
    const find = vi.fn(async () => view(null));
    const create = vi.fn(async () => {
      throw Object.assign(new Error('Only a Branch Manager can change this'), { code: 403 });
    });
    const { client } = clientWith({ find, create });
    const { result } = renderHook(() => useTeammateFrontDesk(client, teammate));
    await waitFor(() => expect(result.current.view).not.toBeNull());

    await act(async () => {
      await result.current.pin(OTHER);
    });
    expect(messages.showError).toHaveBeenCalledWith('Only a Branch Manager can change this');
    expect(result.current.view?.front_desk).toBeNull();
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('keeps every mounted instance for the branch in sync after a pin', async () => {
    const find = vi.fn(async () => view(null));
    const create = vi.fn(async () => view(PINNED));
    const { client } = clientWith({ find, create });
    const header = renderHook(() => useTeammateFrontDesk(client, teammate));
    const settings = renderHook(() => useTeammateFrontDesk(client, teammate));
    await waitFor(() => expect(settings.result.current.view).not.toBeNull());

    await act(async () => {
      await header.result.current.pin(PINNED);
    });
    expect(settings.result.current.view?.front_desk?.session_id).toBe(PINNED);
  });
});
