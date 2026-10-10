import type { AgorClient, Branch, Session, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { filterSessionChoices, TeammateChatCollectionsModal } from './TeammateChatCollectionsModal';

const branch = {
  branch_id: 'branch-1',
  name: 'release-worktree',
  archived: false,
} as unknown as Branch;

function makeSession(sessionId: string, title: string): Session {
  return {
    session_id: sessionId,
    branch_id: branch.branch_id,
    title,
    status: 'idle',
    archived: false,
    last_updated: '2026-08-25T12:00:00.000Z',
  } as unknown as Session;
}

const pinnedSession = makeSession('session-1', 'Existing conversation');
const selectedSession = makeSession('session-2', 'New conversation');
const user = {
  user_id: 'user-1',
  preferences: {
    use_slack_avatar: false,
    custom_preference: { retained: true },
    chat_collections: {
      collections: [
        {
          collection_id: 'release',
          name: 'Release crew',
          session_ids: [pinnedSession.session_id],
        },
      ],
    },
  },
} as unknown as User;

const connected = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

/** A users service that echoes the merged patch back, like the daemon. */
function makeClient(stored: User = user) {
  const patch = vi.fn(async (_id: string, data: Partial<User>) => ({ ...stored, ...data }) as User);
  const get = vi.fn(async () => stored);
  const client = { service: () => ({ get, patch }) } as unknown as AgorClient;
  return { client, patch };
}

describe('TeammateChatCollectionsModal', () => {
  beforeEach(() => {
    agorStore.setState({
      ...EMPTY_MAPS,
      branchById: new Map([[branch.branch_id, branch]]),
      sessionById: new Map([
        [pinnedSession.session_id, pinnedSession],
        [selectedSession.session_id, selectedSession],
      ]),
    });
  });

  afterEach(() => agorStore.getState().reset());

  it('pins a selected session while retaining other user preferences', async () => {
    const { client, patch } = makeClient();
    const onClose = vi.fn();
    render(
      <ConnectionProvider value={connected}>
        <AntApp>
          <TeammateChatCollectionsModal
            open
            client={client}
            currentUser={user}
            preselectedSessionId={selectedSession.session_id}
            onClose={onClose}
          />
        </AntApp>
      </ConnectionProvider>
    );

    const collectionChoices = screen.getByRole('group', {
      name: 'Collections for selected session',
    });
    fireEvent.click(within(collectionChoices).getByRole('checkbox', { name: 'Release crew' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    const [, updates] = patch.mock.calls[0];
    expect(updates.preferences?.use_slack_avatar).toBe(false);
    expect(updates.preferences?.custom_preference).toEqual({ retained: true });
    expect(updates.preferences?.chat_collections?.collections[0].session_ids).toEqual([
      pinnedSession.session_id,
      selectedSession.session_id,
    ]);
    expect(onClose).toHaveBeenCalledOnce();
    // The saved user lands in the store, so Home updates without waiting for an event.
    expect(agorStore.getState().userById.get(user.user_id)?.preferences?.chat_collections).toEqual(
      updates.preferences?.chat_collections
    );
  });

  it('keeps a linked session stable across a source rename', async () => {
    const { client, patch } = makeClient();
    render(
      <ConnectionProvider value={connected}>
        <AntApp>
          <TeammateChatCollectionsModal open client={client} currentUser={user} onClose={vi.fn()} />
        </AntApp>
      </ConnectionProvider>
    );

    act(() => {
      agorStore.setState((state) => ({
        sessionById: new Map(state.sessionById).set(pinnedSession.session_id, {
          ...pinnedSession,
          title: 'Renamed at source',
        }),
      }));
    });

    fireEvent.mouseDown(screen.getByLabelText('Sessions in Release crew'));
    expect((await screen.findAllByText('Renamed at source')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    const [, updates] = patch.mock.calls[0];
    expect(updates.preferences?.chat_collections?.collections[0].session_ids).toEqual([
      pinnedSession.session_id,
    ]);
  });

  it('keeps unsaved edits while sessions update in the background', () => {
    render(
      <ConnectionProvider value={connected}>
        <AntApp>
          <TeammateChatCollectionsModal
            open
            client={makeClient().client}
            currentUser={user}
            onClose={vi.fn()}
          />
        </AntApp>
      </ConnectionProvider>
    );

    const name = screen.getByRole('textbox', { name: 'Collection name' });
    fireEvent.change(name, { target: { value: 'Renamed crew' } });
    act(() => {
      agorStore.setState((state) => ({
        sessionById: new Map(state.sessionById).set(selectedSession.session_id, {
          ...selectedSession,
          status: 'running',
        } as Session),
      }));
    });

    expect(screen.getByRole('textbox', { name: 'Collection name' })).toHaveValue('Renamed crew');
  });

  it('removes a collection and saves the rest', async () => {
    const { client, patch } = makeClient();
    render(
      <ConnectionProvider value={connected}>
        <AntApp>
          <TeammateChatCollectionsModal open client={client} currentUser={user} onClose={vi.fn()} />
        </AntApp>
      </ConnectionProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete Release crew' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(patch.mock.calls[0][1].preferences?.chat_collections).toEqual({ collections: [] });
  });

  it('creates a collection without requiring secure-context randomUUID', () => {
    render(
      <ConnectionProvider value={connected}>
        <AntApp>
          <TeammateChatCollectionsModal
            open
            client={makeClient().client}
            currentUser={{ ...user, preferences: {} }}
            onClose={vi.fn()}
          />
        </AntApp>
      </ConnectionProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: /Create collection/ }));

    expect(screen.getByRole('textbox', { name: 'Collection name' })).toHaveValue('Chat group 1');
  });
});

describe('chat collection session choices', () => {
  it('shows the 50 most recent choices by default and searches the complete set', () => {
    const choices = Array.from({ length: 75 }, (_, index) => ({
      value: `session-${index}`,
      searchText: `conversation ${index}`,
    }));

    expect(filterSessionChoices(choices, '')).toHaveLength(50);
    expect(filterSessionChoices(choices, '')[49].value).toBe('session-49');
    expect(filterSessionChoices(choices, 'conversation 74')).toEqual([choices[74]]);
  });
});
