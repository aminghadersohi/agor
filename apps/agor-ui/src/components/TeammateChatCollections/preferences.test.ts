import type { UserPreferences } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  MAX_SESSIONS_PER_TEAMMATE_CHAT_COLLECTION,
  readTeammateChatPreferences,
  withTeammateChatPreferences,
} from './preferences';

describe('teammate chat preferences', () => {
  it('sanitizes malformed collections, duplicate references, and size limits', () => {
    const result = readTeammateChatPreferences({
      chat_collections: {
        collections: [
          {
            collection_id: 'daily',
            name: ' Daily crew ',
            session_ids: [
              'session-1',
              'session-1',
              ...Array.from(
                { length: MAX_SESSIONS_PER_TEAMMATE_CHAT_COLLECTION + 10 },
                (_, index) => `session-${index + 2}`
              ),
            ],
          },
          { collection_id: 'daily', name: 'Duplicate', session_ids: [] },
          { collection_id: '', name: 'Invalid', session_ids: [] },
        ],
      },
    } as UserPreferences);

    expect(result.collections).toHaveLength(1);
    expect(result.collections[0].name).toBe('Daily crew');
    expect(result.collections[0].session_ids).toHaveLength(
      MAX_SESSIONS_PER_TEAMMATE_CHAT_COLLECTION
    );
    expect(result.collections[0].session_ids.slice(0, 2)).toEqual(['session-1', 'session-2']);
  });

  it('updates teammate collections without discarding unrelated preferences', () => {
    const result = withTeammateChatPreferences(
      { use_slack_avatar: false, custom_preference: { retained: true } },
      {
        collections: [{ collection_id: 'one', name: 'Core team', session_ids: ['session-1'] }],
      }
    );

    expect(result.use_slack_avatar).toBe(false);
    expect(result.custom_preference).toEqual({ retained: true });
    expect(result.chat_collections?.collections[0].session_ids).toEqual(['session-1']);
  });
});
