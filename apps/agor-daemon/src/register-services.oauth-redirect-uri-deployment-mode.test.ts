/**
 * The browser OAuth `redirect_uri` policy follows the deployment mode, not the
 * database engine.
 *
 * `postgresOAuthDeployment` (`isPostgresDatabaseHandle`) is an egress policy: a
 * multi-daemon/hosted deployment must not turn an admin-supplied endpoint into
 * daemon-local outbound traffic. The browser redirect URI is not an egress
 * destination — the provider hands it to the user's browser — so keying its
 * loopback-HTTP exception on the engine made `deployment.mode: standalone` on
 * PostgreSQL reject, at `flow_create`, the very callback that
 * `resolveMcpOAuthCallbackOrigin` had already admitted. That is the shape of
 * Amin's box: standalone + PostgreSQL + `daemon.base_url: http://localhost:5173`.
 *
 * These cases run offline on SQLite with `isPostgresDatabaseHandle` stubbed, so
 * the engine and the deployment mode can be varied independently without a
 * PostgreSQL server. The durable authorities are injected for the same reason:
 * a stubbed engine must not make the daemon reach for PostgreSQL-only SQL.
 *
 * Provider discovery is mocked, but `startMCPOAuthFlow` is deliberately real —
 * it owns the redirect-URI assertion under test. A configured `client_id` keeps
 * DCR, and therefore all network I/O, out of the flow.
 */

import {
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  MCPServerRepository,
  runMigrations,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '@agor/core/db';
import { type Application, feathers } from '@agor/core/feathers';
import type { AuthenticatedParams, MCPServerID, TenantID, UserID } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RegisterServicesContext, registerMCPServices } from './register-services.js';

const MCP_URL = 'https://mcp.provider.example.test/mcp';
const STANDALONE_CALLBACK = 'http://localhost:5173/mcp-servers/oauth-callback';
const HA_CALLBACK = 'https://agor.example.test/mcp-servers/oauth-callback';
const TENANT = 'oauth-redirect-policy-tenant' as TenantID;

/** Flipped per case so the engine and the deployment mode vary independently. */
const engine = vi.hoisted(() => ({ postgres: true }));

vi.mock('@agor/core/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/db')>()),
  isPostgresDatabaseHandle: () => engine.postgres,
}));

// Only discovery is faked. `startMCPOAuthFlow` stays original: it performs the
// `assertSafeOAuthUrl(actualRedirectUri, ...)` call this suite exists to pin.
vi.mock('@agor/core/tools/mcp/oauth-mcp-transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/tools/mcp/oauth-mcp-transport')>()),
  resolveMCPOAuthDiscovery: vi.fn(async () => ({
    kind: 'authorization-server' as const,
    discoveredAt: 'https://mcp.provider.example.test/.well-known/oauth-authorization-server',
    authServerMetadata: {
      issuer: 'https://mcp.provider.example.test',
      authorization_endpoint: 'https://mcp.provider.example.test/authorize',
      token_endpoint: 'https://mcp.provider.example.test/token',
      code_challenge_methods_supported: ['S256'],
    },
  })),
}));

// Constructing an MCP client before a grant exists is a bug, not a fixture.
const unexpectedTransport = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('MCP transport must not be constructed while starting OAuth');
  })
);
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: unexpectedTransport }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: unexpectedTransport,
}));

type StartResult = {
  success: boolean;
  authorizationUrl?: string;
  error?: string;
  recovery?: { category?: string };
};

async function createHarness(options: {
  deploymentMode: 'standalone' | 'ha';
  /** Undefined models a deployment whose config layer admitted no callback. */
  callbackUrl: string | undefined;
  postgres: boolean;
}) {
  engine.postgres = options.postgres;
  const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(rawDb);
  const db = createTenantScopedDatabaseProxy(rawDb);
  const user = await new UsersRepository(rawDb).create({
    email: `redirect-policy-${Math.random()}@example.test`,
    role: 'admin',
  });
  const server = await new MCPServerRepository(rawDb).create({
    name: 'redirect-policy-server',
    transport: 'http',
    url: MCP_URL,
    scope: 'global',
    owner_user_id: user.user_id as UserID,
    auth: {
      type: 'oauth',
      oauth_client_id: 'configured-client-id',
      // Non-strict is required for the AS-direct discovery path; `disabled` DCR
      // makes it explicit that no registration request can be issued.
      oauth_compatibility_mode: 'legacy',
      oauth_dcr_mode: 'disabled',
      oauth_mode: 'per_user',
    },
  });

  const app = feathers() as Application & { io: unknown };
  app.io = {
    local: { to: () => ({ emit: () => {} }) },
    to: () => ({ emit: () => {} }),
    sockets: { sockets: new Map() },
  };

  await runWithTenantDatabaseScope(db, TENANT, () =>
    registerMCPServices({
      db,
      app,
      config: {} as RegisterServicesContext['config'],
      jwtSecret: 'redirect-policy-test-jwt',
      daemonUrl: 'http://127.0.0.1:3030',
      bundledUiAvailable: false,
      DAEMON_PORT: 3030,
      UI_PORT: 5173,
      allowSuperadmin: false,
      requireAuth: async (context) => context,
      deployment: {
        mode: options.deploymentMode,
        capabilities: { mcpOAuth: true },
        ...(options.deploymentMode === 'ha' ? { mcpOAuthCallbackUrl: options.callbackUrl } : {}),
      } as RegisterServicesContext['deployment'],
      // Exactly what index.ts resolves for this mode.
      mcpOAuthCallbackUrl: options.callbackUrl,
      // Injected because the engine is stubbed: the real authorities speak
      // PostgreSQL-only SQL that an in-memory SQLite database cannot serve.
      mcpOAuthPendingFlowAuthority: {
        create: async () => crypto.randomUUID(),
      } as unknown as NonNullable<RegisterServicesContext['mcpOAuthPendingFlowAuthority']>,
      mcpOAuthClientRegistrationAuthority: {
        resolve: vi.fn(),
        lockExactCurrentForAttempt: vi.fn(async () => true),
        invalidateForServer: vi.fn(),
        maintain: vi.fn(),
      } as unknown as NonNullable<RegisterServicesContext['mcpOAuthClientRegistrationAuthority']>,
      lockMcpOAuthGrantConfiguration: async () => undefined,
      // The 401 probe. Nothing else in a passing flow touches the network.
      mcpOAuthFetch: async (_input, _init, assertCurrent) => {
        assertCurrent?.();
        return new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        });
      },
    })
  );

  const params: AuthenticatedParams = {
    provider: 'rest',
    user,
    tenant: { tenant_id: TENANT, source: 'auth_claim' },
    authentication: { strategy: 'jwt', accessToken: 'redirect-policy-token' },
  } as AuthenticatedParams;

  const start = () =>
    app
      .service('mcp-servers/oauth-start')
      .create(
        { mcp_server_id: server.mcp_server_id as MCPServerID },
        params
      ) as Promise<StartResult>;

  return { rawDb, start };
}

describe('MCP browser OAuth redirect_uri policy by deployment mode', () => {
  const harnesses: Array<{ rawDb: unknown }> = [];

  beforeEach(() => {
    vi.stubEnv('AGOR_MASTER_SECRET', 'redirect-policy-test-master-secret');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const harness of harnesses.splice(0)) {
      (harness.rawDb as { $client: { close(): void } })?.$client.close();
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // The regression. Before the fix this returned
  // `{ success: false, recovery: { category: 'redirect_configuration_required' } }`
  // because `flow_create` raised `unsafe_outbound_url` on a callback the config
  // layer had already admitted.
  it.each([
    ['PostgreSQL', true],
    ['SQLite', false],
  ])('starts a standalone sign-in with the localhost callback on %s', async (_engine, postgres) => {
    const harness = await createHarness({
      deploymentMode: 'standalone',
      callbackUrl: STANDALONE_CALLBACK,
      postgres,
    });
    harnesses.push(harness);

    const started = await harness.start();

    expect(started).toMatchObject({ success: true });
    const authorizationUrl = new URL(started.authorizationUrl!);
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(STANDALONE_CALLBACK);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(unexpectedTransport).not.toHaveBeenCalled();
  });

  // Not a blanket relaxation. HA advertises only the https public origin, and a
  // localhost callback must still be refused there. Two layers refuse it, and
  // both are pinned.
  //
  // Layer 1 is what an HA deployment configured this way actually hits:
  // `resolveMcpOAuthCallbackOrigin` returns `haCallbackUrl: null` for a
  // non-https/non-public base URL, so index.ts passes no callback at all and the
  // start is refused before any provider work.
  it.each([
    ['PostgreSQL', true],
    ['SQLite', false],
  ])('refuses an HA sign-in with no public callback on %s', async (_engine, postgres) => {
    const harness = await createHarness({
      deploymentMode: 'ha',
      callbackUrl: undefined,
      postgres,
    });
    harnesses.push(harness);

    await expect(harness.start()).resolves.toMatchObject({
      success: false,
      recovery: { category: 'redirect_configuration_required' },
    });
  });

  // Layer 2 is the assertion this change touched. Even handed a localhost
  // callback directly — which index.ts will not do for HA — the flow still
  // refuses it, because `allowLocalhostRedirectUri` is false outside standalone.
  it.each([
    ['PostgreSQL', true],
    ['SQLite', false],
  ])(
    'refuses a localhost callback at flow_create for an HA deployment on %s',
    async (_engine, postgres) => {
      const harness = await createHarness({
        deploymentMode: 'ha',
        callbackUrl: STANDALONE_CALLBACK,
        postgres,
      });
      harnesses.push(harness);

      const started = await harness.start();

      // `unsafe_outbound_url`, surfaced as the closed configuration category.
      expect(started).toMatchObject({
        success: false,
        recovery: { category: 'configuration_required' },
      });
      expect(started.authorizationUrl).toBeUndefined();
    }
  );

  // The HA happy path still works, so the refusal above is about the callback
  // and not about HA wiring.
  it('starts an HA sign-in with its public https callback', async () => {
    const harness = await createHarness({
      deploymentMode: 'ha',
      callbackUrl: HA_CALLBACK,
      postgres: true,
    });
    harnesses.push(harness);

    const started = await harness.start();

    expect(started).toMatchObject({ success: true });
    expect(new URL(started.authorizationUrl!).searchParams.get('redirect_uri')).toBe(HA_CALLBACK);
  });
});
