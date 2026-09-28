import type { ProfileImageVariant, User } from '@agor-live/client';
import { useCyclingProfileImageUrl } from './useCyclingProfileImage';

type ProfileImageUser = Pick<User, 'user_id' | 'profile_image_id'>;

/**
 * Resolve a user's projected primary photo, falling back to authoritative gallery metadata.
 *
 * Only users with a projected primary have a gallery (the first upload becomes
 * primary and deletion promotes the next image), so users without one never
 * trigger a gallery read. That keeps facepiles and user lists from issuing a
 * request per rendered person.
 */
export function useUserProfileImageUrl(
  user: ProfileImageUser | null | undefined,
  variant: ProfileImageVariant
): string | undefined {
  const hasGallery = Boolean(user?.profile_image_id);
  return useCyclingProfileImageUrl(
    user && hasGallery ? { type: 'user', id: user.user_id } : undefined,
    user?.profile_image_id,
    variant,
    hasGallery
  );
}
