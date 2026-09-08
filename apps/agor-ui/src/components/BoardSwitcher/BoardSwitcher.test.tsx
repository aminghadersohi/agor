import type { AgorClient, Board, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BoardSwitcher } from './BoardSwitcher';

const modalProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('../BoardEditModal', () => ({
  BoardEditModal: (props: Record<string, unknown>) => {
    modalProps.current = props;
    return props.open ? <div role="dialog">board editor</div> : null;
  },
}));

const adversarialBoardName = `Board-${'unbroken-name-'.repeat(30)}終`;
const board = {
  board_id: 'board-1',
  name: adversarialBoardName,
  created_by: 'owner-1',
  primary_owner_user_id: 'owner-1',
  created_at: '',
  last_updated: '',
  worktree_count: 3,
  total_session_count: 12,
  active_session_count: 4,
} as Board;
const owner = { user_id: 'owner-1', role: 'member' } as User;

function clientFor({ reject, findResult }: { reject?: unknown; findResult?: unknown } = {}) {
  return {
    service: () => ({
      find: vi
        .fn()
        .mockImplementation(() =>
          reject ? Promise.reject(reject) : Promise.resolve(findResult ?? [])
        ),
      findAll: vi.fn().mockResolvedValue([]),
    }),
  } as unknown as AgorClient;
}

function renderSwitcher(client = clientFor(), user: User = owner) {
  const onBoardChange = vi.fn();
  const view = render(
    <BoardSwitcher
      boards={[board]}
      currentBoardId={board.board_id}
      onBoardChange={onBoardChange}
      branchById={new Map()}
      client={client}
      currentUser={user}
      onUpdateBoard={vi.fn()}
    />
  );
  return { ...view, onBoardChange };
}

describe('BoardSwitcher long-name layout', () => {
  it('constrains every generated wrapper while keeping the name flexible and counts fixed', async () => {
    const { container } = renderSwitcher();
    const trigger = container.querySelector<HTMLButtonElement>('button.ant-dropdown-trigger');
    expect(trigger).not.toBeNull();

    const currentName = trigger?.querySelector<HTMLElement>('[data-current-board-name]');
    expect(currentName?.parentElement).toHaveStyle({ flex: '1', minWidth: '0' });
    expect(currentName?.parentElement?.style.overflow).toBe('');
    expect(currentName).toHaveStyle({ flex: '1', minWidth: '0' });
    expect(trigger?.querySelector('.anticon-down')).toHaveStyle({ flexShrink: '0' });

    fireEvent.click(trigger as HTMLButtonElement);

    const item = await screen.findByRole('menuitem');
    const itemContent = item.querySelector<HTMLElement>('.ant-dropdown-menu-title-content');
    const name = item.querySelector<HTMLElement>('[data-board-name]');
    const counts = item.querySelector<HTMLElement>('[data-board-list-counts]');
    const avatar = item.querySelector<HTMLElement>('[data-board-list-avatar] > div');
    const popup = screen.getByTestId('board-switcher-popup');

    // jsdom has no layout engine: assert the durable semantic/style contracts,
    // not pixel ellipsis behavior (which is covered in browser E2E).
    expect(itemContent).toHaveStyle({ minWidth: '0' });
    expect(name).toHaveClass('ant-typography-ellipsis');
    expect(name).toHaveStyle({ flex: '1', minWidth: '0' });
    expect(name).toHaveTextContent(adversarialBoardName);
    expect(counts).toBeInTheDocument();
    expect(avatar).toHaveStyle({ width: '36px', height: '36px', flexShrink: '0' });
    expect(popup).toHaveStyle({ width: '360px', maxWidth: 'calc(100vw - 48px)' });
  });

  it('reveals a clipped name when its menu item receives keyboard focus', async () => {
    const { container } = renderSwitcher();
    const trigger = container.querySelector<HTMLButtonElement>('button.ant-dropdown-trigger');
    fireEvent.click(trigger as HTMLButtonElement);

    const item = await screen.findByRole('menuitem');
    const name = item.querySelector<HTMLElement>('[data-board-name]');
    const popup = screen.getByTestId('board-switcher-popup');
    const menu = screen.getByRole('menu');
    expect(name).not.toBeNull();
    Object.defineProperties(name as HTMLElement, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 800 },
    });

    act(() => popup.focus());
    expect(popup).toHaveAttribute('tabindex', '-1');
    expect(menu).toHaveFocus();

    act(() => item.focus());

    expect(item).toHaveFocus();
    expect(name).not.toHaveAttribute('tabindex');
    expect(await screen.findByRole('tooltip')).toHaveTextContent(adversarialBoardName);
  });
});

describe('BoardSwitcher Board-list counts', () => {
  it('shows all authoritative counts with explicit zeroes and accessible labels', async () => {
    const boards = [
      {
        ...board,
        board_id: 'board-zero',
        name: 'Zero',
        worktree_count: 0,
        total_session_count: 0,
        active_session_count: 0,
      },
      {
        ...board,
        board_id: 'board-one',
        name: 'One',
        worktree_count: 1,
        total_session_count: 1,
        active_session_count: 1,
      },
      {
        ...board,
        board_id: 'board-many',
        name: 'Many',
        worktree_count: 3,
        total_session_count: 12,
        active_session_count: 7,
      },
    ] as Board[];
    const { container } = render(
      <BoardSwitcher
        boards={boards}
        currentBoardId="board-zero"
        onBoardChange={vi.fn()}
        branchById={new Map()}
        client={clientFor()}
        currentUser={owner}
      />
    );

    fireEvent.click(container.querySelector('button.ant-dropdown-trigger') as HTMLButtonElement);

    const items = await screen.findAllByRole('menuitem');
    expect(items).toHaveLength(3);
    expect(screen.getByLabelText('0 worktrees')).toBeInTheDocument();
    expect(screen.getByLabelText('0 total sessions')).toBeInTheDocument();
    expect(screen.getByLabelText('0 active sessions')).toBeInTheDocument();
    expect(screen.getByLabelText('1 worktree')).toBeInTheDocument();
    expect(screen.getByLabelText('1 total session')).toBeInTheDocument();
    expect(screen.getByLabelText('1 active session')).toBeInTheDocument();
    expect(screen.getByLabelText('3 worktrees')).toBeInTheDocument();
    expect(screen.getByLabelText('12 total sessions')).toBeInTheDocument();
    expect(screen.getByLabelText('7 active sessions')).toBeInTheDocument();
    for (const item of items) {
      expect(item.querySelector('[data-board-list-counts]')).toBeInTheDocument();
    }
  });
});

describe('BoardSwitcher current-board edit shortcut', () => {
  it('allows the primary owner without consulting a legacy owners route', async () => {
    renderSwitcher(clientFor({ reject: { code: 500 } }));
    expect(await screen.findByRole('button', { name: /Edit current board:/ })).toBeVisible();
  });

  it('passes only the current board to the canonical editor and does not navigate', async () => {
    const { onBoardChange } = renderSwitcher();
    const edit = await screen.findByRole('button', { name: /Edit current board:/ });

    fireEvent.click(edit);

    expect(onBoardChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('board editor');
    expect(modalProps.current?.board).toBe(board);
  });

  it('overlays the edit action without reserving trigger width', async () => {
    renderSwitcher();
    const edit = await screen.findByRole('button', { name: /Edit current board:/ });
    const trigger = edit.closest('div')?.querySelector('button.ant-dropdown-trigger');

    expect(trigger).toHaveStyle({ padding: '8px 12px' });
    expect(edit.closest('span[style*="position: absolute"]')).toHaveStyle({ right: '28px' });
  });

  it('reserves room in the name row so a long name never underlaps the edit action', async () => {
    renderSwitcher();
    const edit = await screen.findByRole('button', { name: /Edit current board:/ });
    const trigger = edit.closest('div')?.querySelector('button.ant-dropdown-trigger');
    // controlHeightSM (24) + paddingSM (12) with the default antd seed token.
    expect(trigger?.querySelector('.ant-flex')).toHaveStyle({ marginRight: '36px' });
  });

  it('keeps the action keyboard reachable and reveals it on focus-within', async () => {
    renderSwitcher();
    const edit = await screen.findByRole('button', { name: /Edit current board:/ });
    act(() => edit.focus());
    expect(edit).toHaveFocus();
    await waitFor(() =>
      expect(edit.closest('span[style*="opacity"]')).toHaveStyle({
        opacity: '1',
        pointerEvents: 'auto',
      })
    );
  });

  it('hides the action when normalized policy resolution denies management', async () => {
    renderSwitcher(clientFor({ findResult: { capabilities: ['board.view'] } }), {
      user_id: 'member-2',
      role: 'member',
    } as User);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Edit current board:/ })).not.toBeInTheDocument()
    );
  });

  it('keeps the action visible without hover on small/touch layouts', async () => {
    renderSwitcher();
    const edit = await screen.findByRole('button', { name: /Edit current board:/ });
    expect(edit).toBeVisible();
  });
});
