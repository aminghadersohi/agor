/** Real-Chromium QA for the shared Board selector row at every configured viewport. */
import type { AgorClient, Board, User } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardSwitcher } from './BoardSwitcher';

const owner = { user_id: 'fictional-owner', role: 'member' } as User;

const boards = [
  {
    board_id: 'fictional-active-board',
    name: 'Fictional active delivery board with a deliberately long responsive name',
    icon: '🦊',
    created_by: owner.user_id,
    primary_owner_user_id: owner.user_id,
    created_at: '2026-09-08T00:00:00.000Z',
    last_updated: '2026-09-08T00:00:00.000Z',
    archived: false,
    worktree_count: 3,
    total_session_count: 12,
    active_session_count: 4,
  },
  {
    board_id: 'fictional-empty-board',
    name: 'Fictional empty board',
    created_by: owner.user_id,
    primary_owner_user_id: owner.user_id,
    created_at: '2026-09-08T00:00:00.000Z',
    last_updated: '2026-09-08T00:00:00.000Z',
    archived: false,
    worktree_count: 0,
    total_session_count: 0,
    active_session_count: 0,
  },
] as Board[];

const client = {
  service: vi.fn(() => ({ find: vi.fn(async () => []), findAll: vi.fn(async () => []) })),
} as unknown as AgorClient;

afterEach(() => cleanup());

describe('BoardSwitcher responsive list (real browser)', () => {
  it('keeps large emoji/fallback avatars, names, and all labelled counts inside the viewport', async () => {
    const { container } = render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <div style={{ width: 260, maxWidth: '100vw' }}>
          <BoardSwitcher
            boards={boards}
            currentBoardId={boards[0].board_id}
            onBoardChange={vi.fn()}
            branchById={new Map()}
            client={client}
            currentUser={owner}
          />
        </div>
      </ConfigProvider>
    );

    await act(async () => {
      fireEvent.click(container.querySelector('button.ant-dropdown-trigger') as HTMLButtonElement);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    const items = await screen.findAllByRole('menuitem');
    expect(items).toHaveLength(2);

    // Portal rows can exist before rc-trigger finishes aligning the popup,
    // even with motion disabled. Measure only the visibly opened surface.
    const popup = screen.getByTestId('board-switcher-popup');
    await waitFor(() => expect(popup).toBeVisible());
    await waitFor(() => expect(popup.getBoundingClientRect().width).toBeGreaterThan(0));

    expect(within(items[0]).getByLabelText('3 worktrees')).toBeVisible();
    expect(within(items[0]).getByLabelText('12 total sessions')).toBeVisible();
    expect(within(items[0]).getByLabelText('4 active sessions')).toBeVisible();
    expect(within(items[1]).getByLabelText('0 worktrees')).toBeVisible();
    expect(within(items[1]).getByLabelText('0 total sessions')).toBeVisible();
    expect(within(items[1]).getByLabelText('0 active sessions')).toBeVisible();

    const popupRect = popup.getBoundingClientRect();
    expect(popupRect.width).toBeLessThanOrEqual(Math.min(360, window.innerWidth - 48) + 1);
    expect(popupRect.left).toBeGreaterThanOrEqual(-1);
    expect(popupRect.right).toBeLessThanOrEqual(window.innerWidth + 1);

    for (const item of items) {
      const avatar = item.querySelector('[data-board-list-avatar] > div') as HTMLElement | null;
      const counts = item.querySelector('[data-board-list-counts]') as HTMLElement | null;
      expect(avatar?.getBoundingClientRect().width).toBeCloseTo(36, 0);
      expect(avatar?.getBoundingClientRect().height).toBeCloseTo(36, 0);
      expect(counts?.getBoundingClientRect().right ?? Infinity).toBeLessThanOrEqual(
        item.getBoundingClientRect().right + 1
      );
      expect(item.scrollWidth).toBeLessThanOrEqual(item.clientWidth + 1);
    }
  });
});
