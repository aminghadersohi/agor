import type { ArtifactCompilationStatus } from '@agor/core/types';
import { useCallback, useState } from 'react';

/**
 * Compilation status for the static preview, which has no bundler to report one.
 *
 * Readiness is keyed to the content hash whose iframe actually loaded, not a
 * boolean cleared by a later effect: after a republish the first render already
 * carries the new hash, and a stale `true` would report `success` for it
 * before the new iframe has loaded.
 */
export function useStaticPreviewReadiness(
  reportHash: string | undefined,
  isStatic: boolean
): { onReady: () => void; compilationStatusOverride: ArtifactCompilationStatus | undefined } {
  const [loadedHash, setLoadedHash] = useState<string | undefined>();
  const onReady = useCallback(() => setLoadedHash(reportHash), [reportHash]);
  return {
    onReady,
    compilationStatusOverride:
      isStatic && reportHash !== undefined && loadedHash === reportHash ? 'success' : undefined,
  };
}
