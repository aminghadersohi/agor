import type { AgorClient, PowerAdmissionStatus } from '@agor-live/client';
import { useEffect, useState } from 'react';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from './useAuthorityOperationGuard';

/**
 * Redacted power admission (`held`, `state`, `reason`) readable by every
 * member. Transitions arrive over realtime; the slow poll only repairs a
 * missed event across reconnects. Read failures resolve to `null` — this is a
 * hint, never a reason to block the composer.
 */
export function usePowerAdmission(
  client: AgorClient | null,
  identityKey: string | null
): PowerAdmissionStatus | null {
  const scope = useAuthenticatedAuthorityScope(client, identityKey);
  const guard = useAuthorityOperationGuard(scope.operationScope);
  const [result, setResult] = useState<{
    scope: typeof scope.operationScope;
    admission: PowerAdmissionStatus | null;
  }>({ scope: null, admission: null });

  useEffect(() => {
    if (!client) return;
    const operation = guard.begin();
    if (!operation.isCurrent()) return;
    const service = client.service('power-management/admission');
    const apply = (admission: PowerAdmissionStatus | null) => {
      if (operation.isCurrent()) setResult({ scope: scope.operationScope, admission });
    };
    const load = async () => {
      try {
        apply(await service.find());
      } catch {
        apply(null);
      }
    };
    void load();
    service.on('patched', apply);
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      operation.cancel();
      window.clearInterval(timer);
      service.off('patched', apply);
    };
  }, [client, guard, scope.operationScope]);

  const current = scope.connectionReady && result.scope === scope.operationScope;
  return current ? result.admission : null;
}
