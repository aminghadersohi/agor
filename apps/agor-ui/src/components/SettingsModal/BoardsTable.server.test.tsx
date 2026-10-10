/**
 * Settings → Boards shows each board's counts from the server-authoritative
 * board list projection (fork: BoardListCounts), so the counts are right with
 * the store's branch and session maps empty and need no per-board reads.
 */
import type { Board } from '@agor-live/client';
import { screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { fakeFeathersClient, mount, withTestAuthority } from '../../test/harness';
import { BoardsTable } from './BoardsTable';

const board = (n: number, active = 0) =>
  ({
    board_id: `board-${n}`,
    name: `Board ${n}`,
    slug: `board-${n}`,
    worktree_count: 0,
    total_session_count: active,
    active_session_count: active,
  }) as unknown as Board;

withTestAuthority('me:member:1', { dataAuthority: false });

it('counts every board’s active sessions from the board list projection', async () => {
  const fake = fakeFeathersClient({});
  const boards = [board(1, 4), ...Array.from({ length: 14 }, (_, i) => board(i + 10))];
  mount(
    <BoardsTable
      client={fake.client}
      boardById={new Map(boards.map((b) => [b.board_id, b]))}
      branchById={new Map()}
    />
  );
  const row = (await screen.findByText('Board 1')).closest('tr') as HTMLElement;
  expect(within(row).getByRole('img', { name: '4 active sessions' })).toBeInTheDocument();
  // A board without active sessions counts 0; every board is listed.
  const other = (await screen.findByText('Board 23')).closest('tr') as HTMLElement;
  expect(within(other).getByRole('img', { name: '0 active sessions' })).toBeInTheDocument();
  expect(fake.callsTo('session-counts')).toEqual([]);
  expect(fake.callsTo('sessions')).toEqual([]);
});
