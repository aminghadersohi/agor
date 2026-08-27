import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('register-services durable OAuth status authority', () => {
  const source = readFileSync(join(__dirname, 'register-services.ts'), 'utf8');
  const start = source.indexOf("app.use('/mcp-servers/oauth-status'");
  const end = source.indexOf("app.use('/mcp-servers/oauth-attempt-status'", start);
  const statusBlock = start < 0 || end < 0 ? '' : source.slice(start, end);
  const refreshStart = source.indexOf("app.use('/mcp-servers/oauth-refresh'");
  const refreshEnd = source.indexOf('// Discover endpoint', refreshStart);
  const refreshBlock =
    refreshStart < 0 || refreshEnd < 0 ? '' : source.slice(refreshStart, refreshEnd);
  const authHeadersStart = source.indexOf("app.use('/mcp-servers/oauth-auth-headers'");
  const authHeadersEnd = source.indexOf(
    "app.service('mcp-servers/oauth-auth-headers').hooks",
    authHeadersStart
  );
  const authHeadersBlock =
    authHeadersStart < 0 || authHeadersEnd < 0
      ? ''
      : source.slice(authHeadersStart, authHeadersEnd);

  // What the endpoint may advertise — expiry, refresh-ambiguity, grant
  // binding, and which servers it will name to which caller — is decided by
  // `resolveAuthenticatedServerIds` and tested against its behaviour in
  // `services/mcp-oauth-status.test.ts`. All this file still owes is that the
  // route asks it rather than deciding for itself.
  it('resolves durable status through the one place that decides it', () => {
    expect(statusBlock).toContain('resolveAuthenticatedServerIds');
    expect(statusBlock).toContain('requireGrantBinding: true');
    expect(statusBlock).toContain('isMCPOAuthGrantAuthorizedForServer(');
  });

  it('gives the refresh owner and observer the same retryable known-failure response', () => {
    expect(refreshBlock).toMatch(
      /err instanceof FailedRefreshError[\s\S]{0,160}error: 'token_refresh_failed'/
    );
  });

  it('supports a daemon-only forced refresh without treating transient failures as revocation', () => {
    expect(authHeadersBlock).toContain('force_refresh?: boolean');
    expect(authHeadersBlock).toContain('data?.force_refresh === true');
    expect(authHeadersBlock).toContain('forceRefresh || needsRefresh');
    expect(authHeadersBlock).toContain("error: 'token_refresh_failed'");
    expect(authHeadersBlock).toMatch(
      /refreshErr instanceof InvalidGrantError[\s\S]{0,100}'needs_reauth'/
    );
  });
});
