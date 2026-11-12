/** Fork: the directory entry keeps the gallery avatar every viewer renders. */

import type { ProfileImageID, User, UserID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { toUserDirectoryEntry } from './user-redaction';

describe('toUserDirectoryEntry (fork profile gallery)', () => {
  it('keeps profile_image_id and still drops private fields', () => {
    const entry = toUserDirectoryEntry({
      user_id: 'user-1' as UserID,
      email: 'someone@example.com',
      profile_image_id: 'image-1' as ProfileImageID,
      role: 'admin',
      unix_username: 'homekey',
      env_vars: { SECRET: 'x' },
    } as Partial<User>);

    expect(entry).toMatchObject({ user_id: 'user-1', profile_image_id: 'image-1' });
    expect(entry).not.toHaveProperty('role');
    expect(entry).not.toHaveProperty('unix_username');
    expect(entry).not.toHaveProperty('env_vars');
  });
});
