import type { Branch, ProfileImageVariant } from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import { useProfileImageGallery } from './useProfileImageGallery';
import { useProfileImageUrl } from './useProfileImageUrl';

/** Resolve the projected primary photo, falling back to authoritative gallery metadata. */
export function useTeammateProfileImageUrl(
  branch: Branch | null | undefined,
  variant: ProfileImageVariant
): string | undefined {
  const teammate = branch && isTeammate(branch) ? branch : undefined;
  const config = teammate ? getTeammateConfig(teammate) : undefined;
  const gallery = useProfileImageGallery(
    teammate ? { type: 'teammate', id: teammate.branch_id } : undefined,
    Boolean(teammate && !config?.profileImageId)
  );
  const fallbackPrimary = gallery.find((image) => image.is_primary) ?? gallery[0];
  return useProfileImageUrl(config?.profileImageId ?? fallbackPrimary?.image_id, variant);
}
