import type { ScreensaverPreferences } from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import { useMemo } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectBranchById } from '../../store/selectors';
import { IdleGlyphScreensaver, resolveScreensaverIdleMinutes } from './IdleGlyphScreensaver';
import type { ScreensaverTeammate } from './TeammatePhotoScreensaver';
import { resolveScreensaverStyle } from './teammatePhotoSlides';

/**
 * App-level screensaver bound to the caller's preferences and the teammates
 * they can already see. Galleries are only fetched once the slideshow starts.
 */
export function IdleScreensaverHost({ preferences }: { preferences?: ScreensaverPreferences }) {
  const branchById = useAgorStore(selectBranchById);
  const teammateKey = useMemo(
    () =>
      JSON.stringify(
        Array.from(branchById.values())
          .filter((branch) => isTeammate(branch) && !branch.archived)
          .map((branch) => [
            branch.branch_id,
            getTeammateConfig(branch)?.displayName || branch.name,
            getTeammateConfig(branch)?.activePhotoTheme ?? null,
          ])
      ),
    [branchById]
  );
  // Keyed on content so unrelated branch patches keep the same array identity.
  const teammates = useMemo<ScreensaverTeammate[]>(
    () =>
      (JSON.parse(teammateKey) as [string, string, string | null][]).map(
        ([id, name, activeTheme]) => ({ id, name, ...(activeTheme ? { activeTheme } : {}) })
      ),
    [teammateKey]
  );

  return (
    <IdleGlyphScreensaver
      idleEnabled={preferences?.enabled === true}
      idleMs={resolveScreensaverIdleMinutes(preferences) * 60_000}
      style={resolveScreensaverStyle(preferences)}
      teammates={teammates}
    />
  );
}
