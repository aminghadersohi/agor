import type { ProfileImageVariant, User } from '@agor-live/client';
import { useProfileImageGallery } from './useProfileImageGallery';
import { useProfileImageUrl } from './useProfileImageUrl';

type ProfileImageUser = Pick<User, 'user_id' | 'profile_image_id'>;

/** Resolve a user's projected primary photo, falling back to authoritative gallery metadata. */
export function useUserProfileImageUrl(
  user: ProfileImageUser | null | undefined,
  variant: ProfileImageVariant
): string | undefined {
  const gallery = useProfileImageGallery(
    user ? { type: 'user', id: user.user_id } : undefined,
    Boolean(user && !user.profile_image_id)
  );
  const fallbackPrimary = gallery.find((image) => image.is_primary) ?? gallery[0];
  return useProfileImageUrl(user?.profile_image_id ?? fallbackPrimary?.image_id, variant);
}
