import type { AgorClient, PowerManagementStatus } from '@agor-live/client';
import { useEffect, useState } from 'react';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from './useAuthorityOperationGuard';

/** Polling refreshes unchanged observations; realtime transitions trigger an immediate read. */
export function usePowerManagementStatus(client: AgorClient, identityKey: string) {
  const scope = useAuthenticatedAuthorityScope(client, identityKey);
  const guard = useAuthorityOperationGuard(scope.operationScope);
  const [result, setResult] = useState<{
    scope: typeof scope.operationScope;
    status: PowerManagementStatus | null;
    error: boolean;
  }>({ scope: null, status: null, error: false });

  useEffect(() => {
    const operation = guard.begin();
    if (!operation.isCurrent()) return;
    const service = client.service('power-management');
    let pending = false;
    let requestTimeout: number | undefined;
    const load = async () => {
      if (pending || !operation.isCurrent()) return;
      pending = true;
      try {
        const status = await Promise.race([
          service.find(),
          new Promise<never>((_, reject) => {
            requestTimeout = window.setTimeout(
              () => reject(new Error('Power status timed out')),
              10000
            );
          }),
        ]);
        if (operation.isCurrent()) setResult({ scope: scope.operationScope, status, error: false });
      } catch {
        if (operation.isCurrent())
          setResult({ scope: scope.operationScope, status: null, error: true });
      } finally {
        window.clearTimeout(requestTimeout);
        requestTimeout = undefined;
        pending = false;
      }
    };
    void load();
    service.on('patched', load);
    const timer = window.setInterval(() => void load(), 5_000);
    return () => {
      operation.cancel();
      window.clearTimeout(requestTimeout);
      window.clearInterval(timer);
      service.off('patched', load);
    };
  }, [client, guard, scope.operationScope]);

  const current = scope.connectionReady && result.scope === scope.operationScope;
  return {
    status: current ? result.status : null,
    error: !scope.connectionReady || (current && result.error),
  };
}
