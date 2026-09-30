/**
 * `{{ user.env.X }}` resolution for the OAuth client fields of a saved MCP
 * server, at the daemon's authorization-code boundaries (oauth-start, the
 * browser flow started by discover/test-oauth, and the client-credentials
 * test).
 *
 * Sessions resolve these templates in the executor from its user-scoped
 * process env. The daemon's own `process.env` never holds user secrets, so a
 * flow started here used to send the stored template text itself as
 * `client_id` / `client_secret` — Google answers that with
 * `Error 401: invalid_client`. Callers load the initiating user's env from the
 * DB and hand it to {@link resolveMCPOAuthClientTemplates}.
 *
 * The resolved values are what the pending flow context carries into the
 * code exchange, and what the grant row persists for refresh. The saved row
 * keeps its templates; grant binding fingerprints the templated row plus the
 * resolved client, so a later env rotation does not silently rebind a grant.
 */

import { AGOR_USER_ENV_KEYS_VAR } from '@agor/core/config';
import {
  buildMCPTemplateContextFromEnv,
  extractMCPTemplateDependencies,
  hasTemplateMarker,
  resolveMcpServerTemplates,
} from '@agor/core/mcp';
import type { MCPAuth, MCPServer, MCPServerID } from '@agor/core/types';

export const MCP_OAUTH_CLIENT_TEMPLATE_FIELDS = [
  'oauth_client_id',
  'oauth_client_secret',
  'oauth_scope',
  'oauth_authorization_url',
  'oauth_token_url',
] as const;

type MCPOAuthClientTemplateField = (typeof MCP_OAUTH_CLIENT_TEMPLATE_FIELDS)[number];

/**
 * A templated OAuth client field could not be resolved for the initiating
 * user. The message names only environment-variable keys (closed
 * `[A-Za-z_][A-Za-z0-9_]*` grammar) and auth field names — never a value — so
 * it is safe to return to the caller and to log.
 */
export class MCPOAuthClientTemplateError extends Error {
  readonly code = 'mcp_oauth_client_template_unresolved';

  constructor(
    readonly missingVars: readonly string[],
    readonly unresolvedFields: readonly string[]
  ) {
    super(
      missingVars.length > 0
        ? `This MCP server's OAuth client configuration uses environment variable(s) that are not set for your account: ${missingVars.join(', ')}. Define them in Settings → Environment Variables, then retry.`
        : `This MCP server's OAuth client configuration has template(s) that did not resolve to a usable value: ${unresolvedFields.join(', ')}. Check the templates and your environment variables, then retry.`
    );
    this.name = 'MCPOAuthClientTemplateError';
  }
}

export function hasMCPOAuthClientTemplates(auth: MCPAuth | undefined): boolean {
  return MCP_OAUTH_CLIENT_TEMPLATE_FIELDS.some((field) => hasTemplateMarker(auth?.[field]));
}

/**
 * Return `auth` with every templated OAuth client field rendered from
 * `userEnv`. Non-templated fields pass through untouched. Throws
 * {@link MCPOAuthClientTemplateError} rather than ever returning a field that
 * is empty or still carries template syntax.
 */
export function resolveMCPOAuthClientTemplates(
  auth: MCPAuth,
  userEnv: Record<string, string>
): MCPAuth {
  const templated = MCP_OAUTH_CLIENT_TEMPLATE_FIELDS.filter((field) =>
    hasTemplateMarker(auth[field])
  );
  if (templated.length === 0) return auth;

  const subset: MCPAuth = { type: 'oauth' };
  for (const field of templated) subset[field] = auth[field];
  // Only the OAuth client fields are rendered here. The placeholder URL keeps
  // the core resolver's server-URL check out of the way; the saved server URL
  // is validated on its own path.
  const now = new Date();
  const probe: MCPServer = {
    mcp_server_id: 'oauth-client-templates' as MCPServerID,
    name: 'oauth-client-templates',
    transport: 'http',
    url: 'https://oauth-client-templates.invalid/',
    auth: subset,
    scope: 'global',
    source: 'user',
    enabled: true,
    created_at: now,
    updated_at: now,
  };
  const result = resolveMcpServerTemplates(
    probe,
    buildMCPTemplateContextFromEnv({
      ...userEnv,
      [AGOR_USER_ENV_KEYS_VAR]: Object.keys(userEnv).join(','),
    })
  );

  const unresolved: MCPOAuthClientTemplateField[] = templated.filter((field) => {
    const value = result.server.auth?.[field];
    return !value?.trim() || hasTemplateMarker(value);
  });
  // `isValid` additionally rejects endpoint overrides that rendered to an
  // unsafe or non-HTTP(S) URL; attribute that to the templated URL fields.
  if (!result.isValid) {
    for (const field of ['oauth_authorization_url', 'oauth_token_url'] as const) {
      if (templated.includes(field) && !unresolved.includes(field)) unresolved.push(field);
    }
  }
  if (unresolved.length > 0) {
    const failed: MCPAuth = { type: 'oauth' };
    for (const field of unresolved) failed[field] = auth[field];
    const { keys } = extractMCPTemplateDependencies({ ...probe, auth: failed });
    const missingVars = [...keys].filter((key) => !userEnv[key]?.trim()).sort();
    throw new MCPOAuthClientTemplateError(
      missingVars,
      unresolved.map((field) => `auth.${field}`)
    );
  }

  const resolved: MCPAuth = { ...auth };
  for (const field of templated) resolved[field] = result.server.auth?.[field];
  return resolved;
}
