import type { Branch, Session, User } from '@agor-live/client';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { HomeFrame } from './HomeSection';
import { CHAT_COLLECTION_PREVIEW, HomeTeammateChatsSection } from './HomeTeammateChatsSection';
import { asDesktop } from './testUtils';

const teammate = {
  branch_id: 'branch-1',
  name: 'operator',
  archived: false,
  custom_context: {
    teammate: { kind: 'teammate', displayName: 'Operator', emoji: '🧭' },
  },
} as unknown as Branch;

const regularBranch = {
  branch_id: 'branch-2',
  name: 'release-worktree',
  archived: false,
} as unknown as Branch;

const makeSession = (id: string, extra: Partial<Session> = {}) =>
  ({
    session_id: id,
    branch_id: teammate.branch_id,
    title: id,
    status: 'idle',
    archived: false,
    genealogy: {},
    agentic_tool: 'codex',
    last_updated: '2026-08-25T12:00:00.000Z',
    ...extra,
  }) as unknown as Session;

const session = makeSession('session-1', { title: 'Daily planning' });
const regularSession = makeSession('session-2', {
  branch_id: regularBranch.branch_id,
  title: 'Release planning',
  last_updated: '2026-08-25T13:00:00.000Z',
});
const archivedSession = makeSession('session-3', { title: 'Old thread', archived: true });

const withCollections = (collections: unknown[]) =>
  ({ user_id: 'user-1', preferences: { chat_collections: { collections } } }) as unknown as User;

const user = withCollections([
  {
    collection_id: 'daily',
    name: 'Daily crew',
    session_ids: [session.session_id, regularSession.session_id, archivedSession.session_id],
  },
]);

function seed(currentUser: User = user, sessions: Session[] = []) {
  agorStore.setState({
    ...EMPTY_MAPS,
    userById: new Map([[currentUser.user_id, currentUser]]),
    branchById: new Map([
      [teammate.branch_id, teammate],
      [regularBranch.branch_id, regularBranch],
    ]),
    sessionById: new Map(
      [session, regularSession, archivedSession, ...sessions].map((s) => [s.session_id, s])
    ),
  });
}

describe('HomeTeammateChatsSection', () => {
  beforeEach(() => seed());
  afterEach(() => vi.restoreAllMocks());

  it('lists live pinned sessions newest first and opens them', () => {
    const onOpenSession = vi.fn();
    render(
      <HomeTeammateChatsSection
        currentUser={user}
        onOpenSession={onOpenSession}
        onManage={vi.fn()}
      />
    );

    const collection = screen.getByRole('region', { name: 'Daily crew' });
    const titles = within(collection)
      .getAllByRole('button')
      .map((row) => row.getAttribute('aria-label'));
    expect(titles[0]).toMatch(/^Release planning/);
    expect(titles[1]).toMatch(/^Daily planning/);
    // Archived sessions never show on Home.
    expect(screen.queryByText('Old thread')).not.toBeInTheDocument();
    expect(within(collection).getByText('2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Daily planning/ }));
    expect(onOpenSession).toHaveBeenCalledWith(session.session_id);
  });

  it('resolves the latest title from the canonical session id after a rename', () => {
    render(
      <HomeTeammateChatsSection currentUser={user} onOpenSession={vi.fn()} onManage={vi.fn()} />
    );

    act(() => {
      agorStore.setState((state) => ({
        sessionById: new Map(state.sessionById).set(session.session_id, {
          ...session,
          title: 'Renamed daily planning',
        }),
      }));
    });

    expect(screen.getByText('Renamed daily planning')).toBeInTheDocument();
    expect(screen.queryByText('Daily planning')).not.toBeInTheDocument();
  });

  it('opens the manager from the header', () => {
    const onManage = vi.fn();
    render(
      <HomeTeammateChatsSection currentUser={user} onOpenSession={vi.fn()} onManage={onManage} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it('follows the store copy of the user over a stale shell snapshot', () => {
    const stale = withCollections([]);
    render(
      <HomeTeammateChatsSection currentUser={stale} onOpenSession={vi.fn()} onManage={vi.fn()} />
    );

    expect(screen.getByRole('region', { name: 'Daily crew' })).toBeInTheDocument();
  });

  it('shows a few rows per collection, then the rest on request', () => {
    const extra = Array.from({ length: CHAT_COLLECTION_PREVIEW + 2 }, (_, i) =>
      makeSession(`many-${i}`, { title: `Thread ${i}` })
    );
    const busy = withCollections([
      { collection_id: 'busy', name: 'Busy', session_ids: extra.map((s) => s.session_id) },
    ]);
    seed(busy, extra);
    render(
      <HomeTeammateChatsSection currentUser={busy} onOpenSession={vi.fn()} onManage={vi.fn()} />
    );

    expect(screen.getAllByRole('button', { name: /^Thread / })).toHaveLength(
      CHAT_COLLECTION_PREVIEW
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(screen.getAllByRole('button', { name: /^Thread / })).toHaveLength(extra.length);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('invites a first collection on desktop', () => {
    asDesktop();
    const empty = withCollections([]);
    seed(empty);
    const onManage = vi.fn();
    render(
      <HomeFrame>
        <HomeTeammateChatsSection currentUser={empty} onOpenSession={vi.fn()} onManage={onManage} />
      </HomeFrame>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create a collection' }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it('stays out of a phone Home until there is a collection', () => {
    const empty = withCollections([]);
    seed(empty);
    render(
      <HomeFrame>
        <HomeTeammateChatsSection currentUser={empty} onOpenSession={vi.fn()} onManage={vi.fn()} />
      </HomeFrame>
    );

    expect(screen.queryByRole('heading', { name: 'Chat collections' })).not.toBeInTheDocument();
  });
});
