import type { Branch, ProfileImageVariant } from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import { useCyclingProfileImageUrl } from './useCyclingProfileImage';

/** Resolve the projected primary photo, falling back to authoritative gallery metadata. */
export function useTeammateProfileImageUrl(
  branch: Branch | null | undefined,
  variant: ProfileImageVariant
): string | undefined {
  const teammate = branch && isTeammate(branch) ? branch : undefined;
  const config = teammate ? getTeammateConfig(teammate) : undefined;
  return useCyclingProfileImageUrl(
    teammate ? { type: 'teammate', id: teammate.branch_id } : undefined,
    config?.profileImageId,
    variant,
    Boolean(teammate)
  );
}
