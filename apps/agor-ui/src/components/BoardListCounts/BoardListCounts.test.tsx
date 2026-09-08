import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BoardListCounts, boardListCountLabel } from './BoardListCounts';

describe('BoardListCounts', () => {
  it('renders explicit, accessible zeroes for all three aggregates', () => {
    const { container } = render(
      <BoardListCounts
        counts={{ worktree_count: 0, total_session_count: 0, active_session_count: 0 }}
      />
    );

    expect(screen.getByLabelText('0 worktrees')).toBeVisible();
    expect(screen.getByLabelText('0 total sessions')).toBeVisible();
    expect(screen.getByLabelText('0 active sessions')).toBeVisible();
    expect(container.querySelector('[data-board-list-count="worktrees"]')).toHaveTextContent('0');
    expect(container.querySelector('[data-board-list-count="totalSessions"]')).toHaveTextContent(
      '0'
    );
    expect(container.querySelector('[data-board-list-count="activeSessions"]')).toHaveTextContent(
      '0'
    );
  });

  it('uses unambiguous singular and plural labels', () => {
    expect(boardListCountLabel('worktrees', 1)).toBe('1 worktree');
    expect(boardListCountLabel('totalSessions', 1)).toBe('1 total session');
    expect(boardListCountLabel('activeSessions', 7)).toBe('7 active sessions');
  });
});
