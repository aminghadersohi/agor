import type { Board, Branch, Session, User } from '@agor-live/client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { HomeChatWorkspaceNav } from './HomeChatWorkspaceNav';

const branch = {
  branch_id: 'branch-1',
  board_id: 'board-1',
  name: 'support-worktree',
  archived: false,
} as unknown as Branch;

const board = {
  board_id: branch.board_id,
  name: 'Support',
  archived: false,
} as unknown as Board;

const teammateBranch = {
  ...branch,
  custom_context: {
    teammate: { kind: 'teammate', displayName: 'Support operator', emoji: '🧭' },
  },
} as unknown as Branch;

const session = {
  session_id: 'session-1',
  branch_id: branch.branch_id,
  title: 'Support triage',
  status: 'running',
  archived: false,
  genealogy: {},
  agentic_tool: 'codex',
  last_updated: '2026-08-25T12:00:00.000Z',
} as unknown as Session;

const alternateSession = {
  ...session,
  session_id: 'session-2',
  title: 'Release planning',
  status: 'idle',
} as unknown as Session;

const availableSession = {
  ...session,
  session_id: 'session-3',
  title: 'Unpinned incident review',
  status: 'idle',
  last_updated: '2026-08-25T13:00:00.000Z',
} as unknown as Session;

const user = {
  user_id: 'user-1',
  preferences: {
    chat_collections: {
      collections: [
        {
          collection_id: 'support',
          name: 'Support crew',
          session_ids: [session.session_id, alternateSession.session_id],
        },
      ],
    },
  },
} as unknown as User;

describe('HomeChatWorkspaceNav', () => {
  beforeEach(() => {
    agorStore.setState({
      ...EMPTY_MAPS,
      userById: new Map([[user.user_id, user]]),
      boardById: new Map([[board.board_id, board]]),
      branchById: new Map([[branch.branch_id, branch]]),
      sessionById: new Map([
        [session.session_id, session],
        [alternateSession.session_id, alternateSession],
        [availableSession.session_id, availableSession],
      ]),
    });
  });

  it('shows grouped sessions and switches the canonical conversation', () => {
    const onSessionClick = vi.fn();
    render(
      <HomeChatWorkspaceNav
        currentUserId={user.user_id}
        activeSessionId={session.session_id}
        onSessionClick={onSessionClick}
        onManage={vi.fn()}
        onExit={vi.fn()}
        onShowOnBoard={vi.fn()}
        onBoardClick={vi.fn()}
      />
    );

    expect(screen.getByText('Support crew')).toBeInTheDocument();
    expect(screen.getByText('Support triage').closest('button')).toHaveAttribute(
      'aria-current',
      'page'
    );

    fireEvent.click(screen.getByText('Release planning'));

    expect(onSessionClick).toHaveBeenCalledWith(alternateSession.session_id);

    const collectionNode = screen.getByText('Support crew').closest('button');
    expect(collectionNode).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(collectionNode!);
    expect(collectionNode).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the active chat back on its board', () => {
    const onShowOnBoard = vi.fn();
    render(
      <HomeChatWorkspaceNav
        currentUserId={user.user_id}
        activeSessionId={session.session_id}
        onSessionClick={vi.fn()}
        onManage={vi.fn()}
        onExit={vi.fn()}
        onShowOnBoard={onShowOnBoard}
        onBoardClick={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show active session on board' }));
    expect(onShowOnBoard).toHaveBeenCalledWith(session.session_id);
  });

  it('shows only selected sessions and keeps discovery in collection management', () => {
    const onManage = vi.fn();
    render(
      <HomeChatWorkspaceNav
        currentUserId={user.user_id}
        activeSessionId={session.session_id}
        onSessionClick={vi.fn()}
        onManage={onManage}
        onExit={vi.fn()}
        onShowOnBoard={vi.fn()}
        onBoardClick={vi.fn()}
      />
    );

    expect(screen.queryByText('Unpinned incident review')).not.toBeInTheDocument();
    expect(
      within(screen.getByText('support-worktree').closest('button')!).getByText('2')
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Manage Support triage in collection' }));
    expect(onManage).toHaveBeenCalledWith(session.session_id);
  });

  it('uses sibling native controls for disclosure and board navigation', async () => {
    const onBoardClick = vi.fn();
    const { container } = render(
      <HomeChatWorkspaceNav
        currentUserId={user.user_id}
        activeSessionId={session.session_id}
        onSessionClick={vi.fn()}
        onManage={vi.fn()}
        onExit={vi.fn()}
        onShowOnBoard={vi.fn()}
        onBoardClick={onBoardClick}
      />
    );

    const disclosure = screen.getByRole('button', {
      name: 'Collapse sessions for support-worktree',
    });
    const boardControl = screen.getByRole('button', { name: 'Open Support board' });

    expect(disclosure).toHaveAttribute('type', 'button');
    expect(boardControl).toHaveAttribute('type', 'button');
    expect(disclosure.tabIndex).toBe(0);
    expect(boardControl.tabIndex).toBe(0);
    expect(disclosure.contains(boardControl)).toBe(false);
    expect(container.querySelector('button button')).toBeNull();

    disclosure.focus();
    expect(disclosure).toHaveFocus();
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(onBoardClick).not.toHaveBeenCalled();

    boardControl.focus();
    expect(boardControl).toHaveFocus();
    fireEvent.click(boardControl);
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(onBoardClick).toHaveBeenCalledWith(board.board_id);

    fireEvent.mouseEnter(boardControl);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Open Support board');
  });

  it('opens the branch board from a teammate avatar too', () => {
    agorStore.setState({ branchById: new Map([[teammateBranch.branch_id, teammateBranch]]) });
    const onBoardClick = vi.fn();
    render(
      <HomeChatWorkspaceNav
        currentUserId={user.user_id}
        activeSessionId={session.session_id}
        onSessionClick={vi.fn()}
        onManage={vi.fn()}
        onExit={vi.fn()}
        onShowOnBoard={vi.fn()}
        onBoardClick={onBoardClick}
      />
    );

    const boardControl = screen.getByRole('button', { name: 'Open Support board' });
    expect(within(boardControl).getByText('🧭')).toBeInTheDocument();
    fireEvent.click(boardControl);

    expect(onBoardClick).toHaveBeenCalledWith(board.board_id);
    expect(
      screen.getByRole('button', { name: 'Collapse sessions for Support operator' })
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it.each([
    {
      name: 'the branch has no board',
      branch: { ...branch, board_id: undefined } as unknown as Branch,
      boards: new Map([[board.board_id, board]]),
    },
    {
      name: 'the target board is archived',
      branch,
      boards: new Map([[board.board_id, { ...board, archived: true } as Board]]),
    },
    {
      name: 'the target board is unavailable',
      branch,
      boards: new Map<string, Board>(),
    },
  ])('keeps the identity icon non-interactive when $name', ({ branch: unavailable, boards }) => {
    agorStore.setState({
      boardById: boards,
      branchById: new Map([[unavailable.branch_id, unavailable]]),
    });
    render(
      <HomeChatWorkspaceNav
        currentUserId={user.user_id}
        activeSessionId={session.session_id}
        onSessionClick={vi.fn()}
        onManage={vi.fn()}
        onExit={vi.fn()}
        onShowOnBoard={vi.fn()}
        onBoardClick={vi.fn()}
      />
    );

    const disclosure = screen.getByRole('button', {
      name: 'Collapse sessions for support-worktree',
    });
    expect(screen.queryByRole('button', { name: /Open .* board/ })).not.toBeInTheDocument();
    expect(within(disclosure.parentElement!).getAllByRole('button')).toEqual([disclosure]);
  });
});
