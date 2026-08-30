import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('session attention acknowledgement route', () => {
  const routeSource = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');
  const serviceSource = readFileSync(join(__dirname, 'services/sessions.ts'), 'utf8');

  it('admits read-only viewers and authorizes the session read before acknowledgement', () => {
    const start = routeSource.indexOf("'/sessions/:id/acknowledge-attention'");
    const end = routeSource.indexOf("'/sessions/:id/fork'", start);
    const route = routeSource.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(route).toContain('role: ROLES.VIEWER');
    expect(route).toContain('sessionsService.acknowledgeAttention(id, params)');

    const methodStart = serviceSource.indexOf('async acknowledgeAttention(');
    const methodEnd = serviceSource.indexOf('\n  /**', methodStart);
    const method = serviceSource.slice(methodStart, methodEnd);
    expect(methodStart).toBeGreaterThan(0);
    expect(method).toContain("this.app.service('sessions').get(id, params)");
    expect(method.indexOf("service('sessions').get")).toBeLessThan(
      method.indexOf('sessionAttentionRepo.acknowledge')
    );
  });
});
