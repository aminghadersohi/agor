import type { ProfileImageVariant, User } from '@agor-live/client';
import { useCyclingProfileImageUrl } from './useCyclingProfileImage';

type ProfileImageUser = Pick<User, 'user_id' | 'profile_image_id'>;

/** Resolve a user's projected primary photo, falling back to authoritative gallery metadata. */
export function useUserProfileImageUrl(
  user: ProfileImageUser | null | undefined,
  variant: ProfileImageVariant
): string | undefined {
  return useCyclingProfileImageUrl(
    user ? { type: 'user', id: user.user_id } : undefined,
    user?.profile_image_id,
    variant,
    Boolean(user)
  );
}
