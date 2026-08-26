import type { Branch, Session, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { TeammateChatCollectionsModal } from './TeammateChatCollectionsModal';

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
    const onUpdateUser = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <AntApp>
        <TeammateChatCollectionsModal
          open
          currentUser={user}
          preselectedSessionId={selectedSession.session_id}
          onClose={onClose}
          onUpdateUser={onUpdateUser}
        />
      </AntApp>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdateUser).toHaveBeenCalledOnce());
    const [, updates] = onUpdateUser.mock.calls[0];
    expect(updates.preferences.use_slack_avatar).toBe(false);
    expect(updates.preferences.custom_preference).toEqual({ retained: true });
    expect(updates.preferences.chat_collections.collections[0].session_ids).toEqual([
      pinnedSession.session_id,
      selectedSession.session_id,
    ]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('creates a collection without requiring secure-context randomUUID', () => {
    render(
      <AntApp>
        <TeammateChatCollectionsModal
          open
          currentUser={{ ...user, preferences: {} }}
          onClose={vi.fn()}
          onUpdateUser={vi.fn()}
        />
      </AntApp>
    );

    fireEvent.click(screen.getByRole('button', { name: /Create collection/ }));

    expect(screen.getByRole('textbox', { name: 'Collection name' })).toHaveValue('Chat group 1');
  });
});
