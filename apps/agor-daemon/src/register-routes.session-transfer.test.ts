import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { realtimePublishPolicyFor } from './utils/realtime-publish-policy.js';
import { TENANT_SERVICE_CLASSIFICATIONS } from './utils/tenant-service-classification.js';

describe('session routing/genealogy REST routes', () => {
  const source = readFileSync(new URL('./register-routes.ts', import.meta.url), 'utf8');
  const routeBody = (path: string) => {
    const start = source.indexOf(`'${path}'`);
    return source.slice(start, source.indexOf('requireAuth', start));
  };

  it('delegates to the same authority-checked service methods the MCP tools use', () => {
    const retarget = routeBody('/sessions/:id/retarget-callback');
    expect(retarget).toContain('sessionsService.retargetCallback(');
    expect(retarget).toContain(
      "create: { role: ROLES.MEMBER, action: 'retarget session callbacks' }"
    );

    const reparent = routeBody('/sessions/:id/reparent');
    expect(reparent).toContain('sessionsService.reparent(');
    expect(reparent).toContain('parentSessionId must be a Session ID or null');
    expect(reparent).toContain("create: { role: ROLES.MEMBER, action: 'reparent sessions' }");
  });

  it('is tenant-scoped and publishes only through the canonical sessions events', () => {
    for (const path of ['sessions/:id/retarget-callback', 'sessions/:id/reparent']) {
      expect(TENANT_SERVICE_CLASSIFICATIONS[path]?.scopeClass).toBe('scoped');
      expect(realtimePublishPolicyFor(path)?.audience).toBe('none');
    }
  });
});
