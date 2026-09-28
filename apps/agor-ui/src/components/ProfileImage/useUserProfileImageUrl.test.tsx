import type { User } from '@agor-live/client';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCyclingProfileImageUrl } from './useCyclingProfileImage';
import { useUserProfileImageUrl } from './useUserProfileImageUrl';

vi.mock('./useCyclingProfileImage', () => ({ useCyclingProfileImageUrl: vi.fn() }));

function user(profileImageId?: string): Pick<User, 'user_id' | 'profile_image_id'> {
  return { user_id: 'user-1', profile_image_id: profileImageId } as Pick<
    User,
    'user_id' | 'profile_image_id'
  >;
}

describe('useUserProfileImageUrl', () => {
  beforeEach(() => {
    vi.mocked(useCyclingProfileImageUrl).mockReset();
    vi.mocked(useCyclingProfileImageUrl).mockReturnValue('blob:current');
  });

  it('cycles the user gallery with the projected primary first', () => {
    const { result } = renderHook(() => useUserProfileImageUrl(user('image-1'), 'small'));

    expect(result.current).toBe('blob:current');
    expect(useCyclingProfileImageUrl).toHaveBeenCalledWith(
      { type: 'user', id: 'user-1' },
      'image-1',
      'small',
      true
    );
  });

  it('never reads a gallery for users without a projected primary', () => {
    renderHook(() => useUserProfileImageUrl(user(), 'small'));

    expect(useCyclingProfileImageUrl).toHaveBeenCalledWith(undefined, undefined, 'small', false);
  });
});
