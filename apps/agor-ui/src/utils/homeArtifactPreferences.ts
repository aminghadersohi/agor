import type { ArtifactID, UserPreferences } from '@agor-live/client';

export const MAX_HOME_ARTIFACTS = 24;

export function readHomeArtifactIds(preferences: UserPreferences | null | undefined): ArtifactID[] {
  const raw = preferences?.home_artifact_ids;
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(raw.filter((value): value is ArtifactID => typeof value === 'string' && !!value))
  ).slice(0, MAX_HOME_ARTIFACTS);
}

export function withHomeArtifactPin(
  preferences: UserPreferences | null | undefined,
  artifactId: ArtifactID,
  pinned: boolean
): UserPreferences {
  const current = readHomeArtifactIds(preferences).filter((id) => id !== artifactId);
  return {
    ...(preferences ?? {}),
    home_artifact_ids: pinned ? [artifactId, ...current].slice(0, MAX_HOME_ARTIFACTS) : current,
  };
}
