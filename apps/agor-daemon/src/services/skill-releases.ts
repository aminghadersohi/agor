/**
 * `skills/releases` — the admin escape hatch behind `agor skills release`.
 *
 * Cuts skill set releases in the configured provider namespaces on behalf of
 * an admin who is **not** inside an Agor session: personal CLI login or API
 * key over REST/Socket.IO. Executor and session tokens, service accounts, MCP
 * and in-process callers are refused, so an agent cannot reach it through its
 * own session credentials. This is how the first release (r1) is cut; later
 * releases come from the curator session (`agor_skillsets_release`).
 *
 * The release itself goes through `skills/release.ts`, and the manifest write
 * carries the skill set governance capability; the actor recorded on the
 * Knowledge version and in the manifest is the admin.
 */

import {
  requireCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { type Application, BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  hasMinimumRole,
  type Params,
  ROLES,
  type UserID,
} from '@agor/core/types';
import { EXECUTOR_SESSION_TOKEN_TYPE } from '../auth/executor-session-token.js';
import { KnowledgeSkillProvider } from '../skills/knowledge-skill-provider.js';
import {
  type ReleaseRunResult,
  releaseAllTeammates,
  releaseNamespaces,
  runReleases,
} from '../skills/release.js';
import { resolveSkillTeammate } from '../skills/teammate.js';

export interface SkillReleaseRequest {
  teammate?: string;
  all?: boolean;
  namespace?: string;
  expectedVersion?: number | string;
}

const OUTSIDE_SESSION_MESSAGE =
  'agor skills release runs as an admin outside any Agor session (your own CLI login or API key).';

/** Refuse anything but an admin's own external login. */
export function assertAdminOutsideSession(params: Params | undefined): {
  user: NonNullable<AuthenticatedParams['user']>;
} {
  const authenticated = params as AuthenticatedParams | undefined;
  const user = authenticated?.user;
  if (!user?.user_id) throw new NotAuthenticated('Authentication required');
  const provider = authenticated?.provider;
  if (
    !provider ||
    provider === 'mcp' ||
    user._isServiceAccount === true ||
    (authenticated?.authentication?.payload as { type?: unknown } | undefined)?.type ===
      EXECUTOR_SESSION_TOKEN_TYPE
  ) {
    throw new Forbidden(OUTSIDE_SESSION_MESSAGE);
  }
  if (!hasMinimumRole(user.role, ROLES.ADMIN)) {
    throw new Forbidden('Cutting skill set releases from the CLI requires the admin role.');
  }
  return { user };
}

function parseRequest(data: unknown): SkillReleaseRequest {
  const raw = (data ?? {}) as Record<string, unknown>;
  const teammate = typeof raw.teammate === 'string' ? raw.teammate.trim() : undefined;
  const all = raw.all === true;
  if (!teammate === !all) throw new BadRequest('Pass exactly one of teammate or all.');
  const namespace = typeof raw.namespace === 'string' ? raw.namespace.trim() : undefined;
  const expectedVersion = raw.expectedVersion;
  if (
    expectedVersion !== undefined &&
    !(
      typeof expectedVersion === 'number' &&
      Number.isInteger(expectedVersion) &&
      expectedVersion >= 0
    ) &&
    !(
      typeof expectedVersion === 'string' &&
      expectedVersion.length > 0 &&
      expectedVersion.length <= 64
    )
  ) {
    throw new BadRequest('expectedVersion must be a version number or version id.');
  }
  if (all && expectedVersion !== undefined) {
    throw new BadRequest('expectedVersion applies to a single teammate, not all.');
  }
  return {
    ...(teammate ? { teammate } : { all: true }),
    ...(namespace ? { namespace } : {}),
    ...(expectedVersion !== undefined
      ? { expectedVersion: expectedVersion as number | string }
      : {}),
  };
}

export function createSkillReleasesRoute(options: { db: TenantScopeAwareDatabase }) {
  const { db } = options;
  let app: Application | undefined;

  return {
    async setup(featherApp: Application): Promise<void> {
      app = featherApp;
    },

    async create(data: SkillReleaseRequest, params?: Params): Promise<ReleaseRunResult> {
      if (!app) throw new Error('skills/releases used before setup');
      const { user } = assertAdminOutsideSession(params);
      const request = parseRequest(data);
      const authenticated = params as AuthenticatedParams;
      const provider = new KnowledgeSkillProvider(app, {
        user,
        authenticated: true,
        provider: authenticated.provider,
        ...(authenticated.tenant ? { tenant: authenticated.tenant } : {}),
      } as Params);
      const namespaces = await releaseNamespaces(provider, request.namespace);
      if (namespaces.length === 0) {
        throw new BadRequest(
          'No configured skills provider namespace is readable. List providers under `skills.providers` in config.yaml.'
        );
      }
      if (request.expectedVersion !== undefined && namespaces.length > 1) {
        throw new BadRequest('expectedVersion needs --namespace when several providers exist.');
      }
      const userId = user.user_id as UserID;
      // The route has tenant context but no request-long transaction
      // (`transaction: false`); each direct read opens its own short,
      // tenant-bound unit. Knowledge reads and writes go through kb/* services.
      const tenantId =
        authenticated.tenant?.tenant_id ??
        requireCurrentTenantId('Missing tenant context for skill releases');
      const withDb = <T>(work: (scoped: TenantScopeAwareDatabase) => Promise<T>): Promise<T> =>
        runWithTenantDatabaseScope(db, tenantId, (scoped) =>
          work(scoped as unknown as TenantScopeAwareDatabase)
        );
      const teammate = request.teammate
        ? await withDb((scoped) => resolveSkillTeammate(scoped, request.teammate as string, userId))
        : null;
      return runReleases({
        provider,
        namespaces,
        teammate,
        listAllTeammates: (namespace) => releaseAllTeammates(withDb, userId, provider, namespace),
        authorize: () => ({ allowed: true, as: 'admin' }),
        actor: userId,
        ...(request.expectedVersion !== undefined
          ? { expectedVersion: request.expectedVersion }
          : {}),
      });
    },
  };
}
