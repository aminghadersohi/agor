/**
 * Browser `redirect_uri` safety policy, kept separate from egress policy.
 *
 * The redirect URI is handed to the provider and resolved by the user's
 * browser; this process never opens a socket to it. Its loopback-HTTP
 * exception is therefore the deployment's own callback decision
 * (`allowLocalhostRedirectUri`), not the daemon's outbound-fetch policy
 * (`allowLocalhostHttp`). A standalone deployment on PostgreSQL keeps strict
 * egress while still advertising the localhost callback its configuration layer
 * already admitted.
 *
 * This suite deliberately uses the real `safe-outbound-fetch`. The sibling
 * `oauth-mcp-transport.test.ts` stubs it with an HTTPS/loopback-only
 * approximation, which cannot show that embedded credentials, fragments and
 * private subnets are still refused once the loopback exception is granted.
 *
 * Every case supplies a configured `client_id` and prefetched AS metadata, so a
 * passing flow performs no network I/O at all — asserted below.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsafeOutboundUrlError } from '../../utils/safe-outbound-fetch';
import { startMCPOAuthFlow } from './oauth-mcp-transport';

const MCP_URL = 'https://mcp.provider.example.test/mcp';
const STANDALONE_CALLBACK = 'http://localhost:5173/mcp-servers/oauth-callback';

/**
 * Mirrors the daemon's flow-create call: AS metadata already discovered, a
 * configured client, and `resourceUri` pinned to the MCP server URL.
 */
function startFlow(
  redirectUri: string,
  policy: { allowLocalhostHttp: boolean; allowLocalhostRedirectUri?: boolean }
) {
  return startMCPOAuthFlow('', 'configured-client', redirectUri, {
    prefetchedAuthServerMetadata: {
      issuer: 'https://mcp.provider.example.test',
      authorization_endpoint: 'https://mcp.provider.example.test/authorize',
      token_endpoint: 'https://mcp.provider.example.test/token',
      code_challenge_methods_supported: ['S256'],
    },
    cacheKey: MCP_URL,
    resourceUri: MCP_URL,
    compatibilityMode: 'marketplace',
    dcrMode: 'advertised',
    ...policy,
  });
}

describe('browser redirect_uri loopback policy', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The reported failure: `deployment.mode: standalone` on PostgreSQL with
  // `daemon.base_url: http://localhost:5173`. Egress stays strict because the
  // database engine is PostgreSQL; the callback is still the one the config
  // layer admitted, so `flow_create` must not raise `unsafe_outbound_url`.
  it.each([
    ['localhost', STANDALONE_CALLBACK],
    ['127.0.0.1', 'http://127.0.0.1:5173/mcp-servers/oauth-callback'],
    ['[::1]', 'http://[::1]:5173/mcp-servers/oauth-callback'],
  ])('admits the standalone %s callback while egress stays strict', async (_host, callback) => {
    const context = await startFlow(callback, {
      allowLocalhostHttp: false,
      allowLocalhostRedirectUri: true,
    });

    expect(context.redirectUri).toBe(callback);
    expect(new URL(context.authorizationUrl).searchParams.get('redirect_uri')).toBe(callback);
    // The egress policy travels unchanged onto the context, so the callback
    // leg's token-endpoint fetch stays strict for this same flow.
    expect(context.allowLocalhostHttp).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Not a blanket relaxation: an HA deployment advertises only its https public
  // origin, and a localhost callback must still be refused there.
  it.each([
    ['explicitly denied', false],
    ['unset', undefined],
  ])('refuses the loopback callback when the deployment policy is %s', async (_label, allowed) => {
    await expect(
      startFlow(STANDALONE_CALLBACK, {
        allowLocalhostHttp: false,
        allowLocalhostRedirectUri: allowed,
      })
    ).rejects.toThrow(UnsafeOutboundUrlError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Only the http-on-loopback rule differs. Everything else `assertSafeOAuthUrl`
  // refuses must still be refused with the exception granted.
  it.each([
    ['embedded credentials', 'http://user:secret@localhost:5173/mcp-servers/oauth-callback'],
    ['a fragment', 'http://localhost:5173/mcp-servers/oauth-callback#token'],
    ['plaintext on a private subnet', 'http://10.33.92.175:5173/mcp-servers/oauth-callback'],
    ['https on a private subnet', 'https://10.33.92.175/mcp-servers/oauth-callback'],
    ['plaintext on a public host', 'http://agor.example.test/mcp-servers/oauth-callback'],
    ['a link-local metadata host', 'https://metadata.google.internal/mcp-servers/oauth-callback'],
    ['a non-loopback .localhost name', 'http://evil.localhost/mcp-servers/oauth-callback'],
  ])('still refuses a redirect URI with %s', async (_label, callback) => {
    await expect(
      startFlow(callback, { allowLocalhostHttp: false, allowLocalhostRedirectUri: true })
    ).rejects.toThrow(UnsafeOutboundUrlError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Legacy CLI/loopback callers pass only `allowLocalhostHttp`; omitting the
  // new option must not tighten them.
  it('falls back to the egress policy when the deployment policy is absent', async () => {
    const callback = 'http://127.0.0.1:9999/oauth/callback';
    const context = await startFlow(callback, { allowLocalhostHttp: true });

    expect(context.redirectUri).toBe(callback);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
