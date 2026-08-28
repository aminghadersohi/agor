/**
 * Artifact Type Definitions
 *
 * Artifacts are board-scoped, DB-backed live web applications rendered via Sandpack.
 * The filesystem folder is a transient staging area; on publish, the daemon serializes
 * folder contents into the DB `files` column. Serving reads from DB only.
 *
 * Format: standard JS file map + DB metadata. No `sandpack.json` sidecar, no
 * `agor.config.js` Handlebars sidecar. Env vars are declared on the artifact row
 * (`required_env_vars`) and synthesized into `.env` at render time. Daemon
 * capabilities are declared explicitly via `agor_grants`. See
 * `apps/agor-docs/pages/guide/artifacts.mdx` and
 * `docs/internal/artifacts-roadmap-2026-05-09.md`.
 */

import type { SandpackTemplate } from './board';
import type { ArtifactID, BoardID, BranchID, SessionID, UserID, UUID } from './id';
import type { ScheduleID } from './schedule';

/**
 * Common envelope for every declared artifact binding.
 *
 * The `id` is the *only* thing artifact JavaScript ever supplies. It is
 * artifact-local and opaque: it names a binding the author persisted, never a
 * tool, route, resource, field, or argument. Everything that decides what
 * actually happens lives in the family-specific member below and was validated
 * against the artifact's source branch at bind time.
 */
export interface ArtifactBindingBase {
  /** Stable, artifact-local identifier named by the `window.agor` call. */
  id: string;
  /** Human-readable label used by management and confirmation UI. */
  label: string;
  description?: string;
}

/**
 * What a declared action binding does when invoked.
 *
 * Discriminated so a new action kind is an added variant rather than a schema
 * migration. **Every field is pinned at bind time** — the iframe supplies only
 * the binding's `id`, never an argument. A toggle is therefore two declared
 * bindings (`enabled: true` and `enabled: false`), not one binding with a
 * caller-supplied boolean. See
 * `context/explorations/artifact-interaction-bindings.md`.
 */
export type ArtifactActionEffect =
  | { kind: 'schedule_run'; schedule_id: ScheduleID }
  | { kind: 'schedule_set_enabled'; schedule_id: ScheduleID; enabled: boolean };

export const ARTIFACT_ACTION_EFFECT_KINDS = ['schedule_run', 'schedule_set_enabled'] as const;
export type ArtifactActionEffectKind = ArtifactActionEffect['kind'];

/**
 * A user-triggered *write*. `window.agor.runAction(id)`.
 *
 * Executes through the ordinary authenticated service route with the viewer's
 * own credentials, so an artifact button can never do something the viewer
 * could not do by hand in the UI.
 */
export interface ArtifactActionBinding extends ArtifactBindingBase {
  effect: ArtifactActionEffect;
  /** Require a trusted parent-page confirmation before the effect is applied. */
  confirm?: boolean;
}

/**
 * Where a declared data binding reads from.
 *
 * Each kind is implemented as a service `get` followed by a fixed field
 * projection, which is what makes "a data binding cannot mutate anything" a
 * structural property rather than a runtime check. All identifiers are pinned
 * at bind time and validated against the artifact's source branch.
 */
export type ArtifactDataSource =
  | { kind: 'schedule_status'; schedule_id: ScheduleID }
  | { kind: 'session_status'; session_id: SessionID };

export const ARTIFACT_DATA_SOURCE_KINDS = ['schedule_status', 'session_status'] as const;
export type ArtifactDataSourceKind = ArtifactDataSource['kind'];

/** A declared *read*. `window.agor.fetchData(id)`. */
export interface ArtifactDataBinding extends ArtifactBindingBase {
  source: ArtifactDataSource;
}

/**
 * A session the artifact can surface. `window.agor.openChat(id)`.
 *
 * A named set rather than a single session, so a widget can offer more than one
 * conversation and so an author can retire and replace a target session with a
 * metadata patch instead of republishing the artifact's code.
 */
export interface ArtifactChatBinding extends ArtifactBindingBase {
  session_id: SessionID;
}

/**
 * Declarative, server-validated interactions available to an artifact.
 *
 * Artifact JavaScript never receives an API token and cannot choose an arbitrary
 * schedule, session, or tool. The parent page accepts only identifiers declared
 * here and then calls the normal authenticated service path with the viewer's
 * own credentials.
 *
 * The three families are separate arrays rather than one list discriminated by
 * `kind`. That separation is a security property, not organization: a read id
 * simply does not exist in the actions collection, so "a data binding cannot
 * reach a mutating dispatch" holds by construction instead of depending on a
 * kind check that a future edit could forget.
 */
export interface ArtifactInteractionConfig {
  /** Writes. */
  actions?: ArtifactActionBinding[];
  /** Reads. */
  data?: ArtifactDataBinding[];
  /** Sessions openable in the parent surface. */
  chats?: ArtifactChatBinding[];
}

/**
 * Projected, non-secret result of a data binding read.
 *
 * The daemon never returns the underlying resource — only these fixed field
 * sets. Widening a projection is a deliberate edit here, which is the point.
 */
export type ArtifactDataResult =
  | {
      kind: 'schedule_status';
      schedule_id: ScheduleID;
      name: string;
      enabled: boolean;
      cron_expression: string;
      timezone?: string;
      timezone_mode?: string;
      next_run_at?: number | null;
      last_run_at?: number | null;
      last_run_session_id?: SessionID | null;
      allow_concurrent_runs?: boolean;
    }
  | {
      kind: 'session_status';
      session_id: SessionID;
      title?: string;
      status: string;
      agentic_tool: string;
      archived: boolean;
      last_updated: string;
    };

/**
 * Build status for artifacts
 */
export type ArtifactBuildStatus = 'unknown' | 'checking' | 'success' | 'error';

/**
 * Allow-listed Sandpack provider config that authors can persist on an artifact.
 *
 * The shape mirrors a subset of `SandpackProviderProps` from
 * `@codesandbox/sandpack-react`. Anything outside the allow list is stripped
 * by `sanitizeSandpackConfig` before persistence — see
 * `apps/agor-daemon/src/utils/sandpack-config.ts` for the canonical allow list
 * and the rationale for each block.
 *
 * `customSetup.dependencies` lives here as a denormalized convenience. The
 * authoritative source for runtime deps is `package.json#dependencies` in the
 * file map.
 */
export interface SandpackConfig {
  template?: SandpackTemplate;
  customSetup?: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    entry?: string;
    environment?: string;
  };
  theme?: 'light' | 'dark' | 'auto' | Record<string, unknown>;
  options?: {
    activeFile?: string;
    visibleFiles?: string[];
    layout?: 'preview' | 'tests' | 'console';
    recompileMode?: 'immediate' | 'delayed';
    recompileDelay?: number;
    initMode?: 'lazy' | 'immediate' | 'user-visible';
    autorun?: boolean;
    autoReload?: boolean;
    showNavigator?: boolean;
    showLineNumbers?: boolean;
    showInlineErrors?: boolean;
    showRefreshButton?: boolean;
    showTabs?: boolean;
    showConsole?: boolean;
    showConsoleButton?: boolean;
    closableTabs?: boolean;
    startRoute?: string;
    classes?: Record<string, string>;
    [key: string]: unknown;
  };
}

/**
 * Discrete daemon-supplied capabilities granted to an artifact.
 *
 * Each grant maps to a fixed env var name (see GRANT_ENV_VAR_NAMES in
 * `packages/core/src/types/artifact-grants.ts`). Grants that expose viewer
 * information are part of the artifact consent surface; informational
 * coordinates such as `agor_artifact_id` do not require consent.
 */
export interface AgorGrants {
  /** Inject the daemon's base URL as AGOR_API_URL. */
  agor_api_url?: boolean;
  /** Inject viewer's email as AGOR_USER_EMAIL. */
  agor_user_email?: boolean;
  /** Inject this artifact's ID as AGOR_ARTIFACT_ID (informational, no consent). */
  agor_artifact_id?: boolean;
  /** Inject the artifact's board ID as AGOR_BOARD_ID (informational, no consent). */
  agor_board_id?: boolean;
}

/**
 * Per-artifact configuration for the daemon-injected `agor-runtime.js`.
 *
 * The runtime is a small (~30 lines) iframe-side script that listens for
 * `postMessage` queries from the Agor parent page (e.g. `agor:query` with
 * a CSS selector) and replies with serialized DOM snapshots. Agents call
 * the matching MCP tools (e.g. `agor_artifacts_query_dom`) which fan out
 * to the active viewer's browser, dispatch to the iframe, and return the
 * iframe's reply.
 *
 * Injected at render time (in `getPayload`) as a `data:text/javascript`
 * URL added to `sandpack_config.options.externalResources`. The persisted
 * `files` column and `sandpack_config` are never mutated. Doesn't show up
 * in CodeSandbox exports for the same reason: it talks to an Agor parent
 * that doesn't exist outside Agor.
 *
 * Defaults to enabled. Authors can opt out (`enabled: false`) for
 * artifacts that should not be introspectable, or for artifacts whose
 * own code conflicts with our message listener.
 */
export interface AgorRuntimeConfig {
  /**
   * Inject the daemon-side `agor-runtime.js` into the served bundle (as an
   * iframe-level `<script>` via Sandpack's `externalResources`). Defaults
   * to `true`.
   */
  enabled?: boolean;

  /** Declarative, parent-mediated controls available to the artifact. */
  interactions?: ArtifactInteractionConfig;
}

/**
 * Artifact - Live web application rendered via Sandpack on the board canvas
 *
 * Artifacts are board-scoped, DB-backed objects. The `files` column holds the
 * serialized source code. `branch_id` and `path` are provenance only.
 */
export interface Artifact {
  artifact_id: ArtifactID;

  /** Branch provenance (nullable — survives branch deletion via SET NULL) */
  branch_id: BranchID | null;

  /** Session that most recently created/published this artifact, when known. */
  source_session_id?: SessionID | null;

  /** Board this artifact is displayed on */
  board_id: BoardID;

  /** Display name */
  name: string;

  /** Optional description */
  description?: string;

  /** Provenance path — where files were read from (nullable) */
  path: string | null;

  /** Sandpack template */
  template: SandpackTemplate;

  /** Current build status */
  build_status: ArtifactBuildStatus;

  /** Last build error messages (if build_status === 'error') */
  build_errors?: string[];

  /** Content hash for cache invalidation (MD5 of sorted file contents) */
  content_hash?: string;

  /** Serialized file contents: path -> code. Null for legacy records not yet re-published. */
  files?: Record<string, string>;

  /**
   * Denormalized cache of `package.json#dependencies`. The file-map's
   * `package.json` is canonical; this column is rebuilt from it on publish.
   */
  dependencies?: Record<string, string>;

  /** Denormalized cache of the Sandpack entry file (e.g. `/index.js`). */
  entry?: string;

  /**
   * Author-controlled Sandpack provider config. Spread into `<SandpackProvider>`
   * at render time, after defaults are merged. Sanitized on write (see
   * `sanitizeSandpackConfig`).
   */
  sandpack_config?: SandpackConfig;

  /**
   * Names of env vars this artifact needs. The daemon synthesizes a `.env` file
   * with the viewer's values at payload-fetch time, prefixed per the
   * template's bundler convention (Vite → `VITE_`, CRA → `REACT_APP_`, etc.).
   *
   * Names are stored without prefix (e.g. `["OPENAI_KEY", "STRIPE_KEY"]`).
   */
  required_env_vars?: string[];

  /**
   * Daemon-injected `agor-runtime.js` config. Default behavior (when this
   * field is null/undefined) is enabled — agents calling
   * `agor_artifacts_query_dom` etc. will get responses from any browser
   * currently viewing the artifact. Set `enabled: false` to opt out.
   */
  agor_runtime?: AgorRuntimeConfig;

  /** Daemon capabilities the artifact wants the daemon to inject. */
  agor_grants?: AgorGrants;

  /** Whether this artifact is visible to all board viewers */
  public: boolean;

  /** User who created this artifact */
  created_by?: string;

  created_at: string;
  updated_at: string;

  /** Whether this artifact is archived */
  archived: boolean;
  /**
   * When the artifact was archived. Null/undefined when not archived; a
   * timestamp when archived. Always cleared on unarchive (NULL in DB).
   */
  archived_at?: string | null;

  /**
   * External/user-facing URL for viewing this artifact fullscreen, outside
   * board canvas/card chrome. Format: `{baseUrl}/ui/a/{artifactShortId}/fullscreen`
   * Append `?show_navbar=false` client-side to hide the compact navbar.
   */
  fullscreen_url?: string | null;

  /**
   * External/user-facing URL for viewing this artifact in the UI.
   *
   * Computed property added by the repository layer. Optional —
   * undefined on inputs / fixtures constructed by hand; on read paths
   * from the repo it's `string` when the artifact is placed on a
   * board, `null` otherwise (the share link has nothing to switch to).
   * Format: `{baseUrl}/ui/a/{artifactShortId}/`
   * Visiting the URL switches to the artifact's board and recenters
   * the canvas on its card.
   */
  url?: string | null;
}

/**
 * Artifact list fields that are expensive or unnecessary for initial canvas
 * hydration, but are still part of the legacy non-file list DTO.
 *
 * This list owns the projection policy: every other Artifact field except
 * `files` is metadata. Adding a new Artifact field therefore makes the
 * exhaustive metadata map below fail typechecking until its list behavior is
 * considered explicitly.
 */
export const ARTIFACT_RUNTIME_LIST_FIELDS_WITHOUT_FILES = [
  'dependencies',
  'entry',
  'sandpack_config',
  'required_env_vars',
  'agor_grants',
  'agor_runtime',
] as const satisfies readonly (keyof Artifact)[];

export type ArtifactRuntimeListFieldWithoutFiles =
  (typeof ARTIFACT_RUNTIME_LIST_FIELDS_WITHOUT_FILES)[number];
export type ArtifactListFieldWithoutFiles = Exclude<keyof Artifact, 'files'>;
export type ArtifactMetadataListField = Exclude<
  ArtifactListFieldWithoutFiles,
  ArtifactRuntimeListFieldWithoutFiles
>;

const artifactMetadataListFieldMap = {
  artifact_id: true,
  branch_id: true,
  source_session_id: true,
  board_id: true,
  name: true,
  description: true,
  path: true,
  template: true,
  build_status: true,
  build_errors: true,
  content_hash: true,
  public: true,
  created_by: true,
  created_at: true,
  updated_at: true,
  archived: true,
  archived_at: true,
  fullscreen_url: true,
  url: true,
} as const satisfies Record<ArtifactMetadataListField, true>;

/** Lean artifact DTO used by the initial canvas hydration. */
export const ARTIFACT_METADATA_LIST_FIELDS = Object.freeze(
  Object.keys(artifactMetadataListFieldMap) as ArtifactMetadataListField[]
);

/** Artifact list response fields that preserve the legacy DTO while omitting source files. */
export const ARTIFACT_LIST_FIELDS_WITHOUT_FILES = Object.freeze([
  ...ARTIFACT_METADATA_LIST_FIELDS,
  ...ARTIFACT_RUNTIME_LIST_FIELDS_WITHOUT_FILES,
]) satisfies readonly ArtifactListFieldWithoutFiles[];

/**
 * Artifact payload served to frontend via REST.
 *
 * Contains everything needed to render the Sandpack preview. The daemon
 * resolves consent and synthesizes the `.env` file before returning. The
 * `trust_state` field tells the UI whether secrets were actually injected.
 */
export interface ArtifactPayload {
  artifact_id: ArtifactID;
  /** Session that most recently created/published this artifact, when known. */
  source_session_id?: SessionID | null;
  name: string;
  description?: string;
  template: SandpackTemplate;
  /** File map: path -> code content. May include a synthesized `/.env`. */
  files: Record<string, string>;
  /** Author-controlled Sandpack config (spread into `<SandpackProvider>`). */
  sandpack_config?: SandpackConfig;
  dependencies?: Record<string, string>;
  entry?: string;
  content_hash: string;
  /**
   * Non-secret hash of files plus persisted render-affecting metadata. Browser
   * runtime reports include this so the daemon can reject stale reports after
   * metadata-only render changes.
   */
  runtime_report_hash?: string;
  /** Names of env vars the artifact requires (without prefix). */
  required_env_vars?: string[];
  /** Grants the artifact requested. */
  agor_grants?: AgorGrants;
  /** Viewer-authorized subset of the artifact's configured interactions. */
  interaction_config?: ArtifactInteractionConfig;
  /**
   * Whether the daemon injected secrets into this payload.
   *
   * - 'self' — viewer is the author; secrets always injected.
   * - 'trusted' — an active trust grant matched the requested set.
   * - 'untrusted' — empty values injected; UI should offer the consent flow.
   * - 'no_secrets_needed' — artifact requested no env vars or grants.
   */
  trust_state: ArtifactTrustState;
  /**
   * Where the matching grant was found (only set when trust_state==='trusted').
   * Useful for the UI to render a precise badge ("Trusted (Alice)" vs
   * "Trusted (this artifact)").
   */
  trust_scope?: ArtifactTrustScopeType;
  /**
   * Legacy-format detection result. Present when the artifact was published
   * with the pre-2026-05 format (sandpack.json sidecar / agor.config.js
   * Handlebars). The UI surfaces `legacy.upgrade_instructions` as a banner
   * with copyable agent prompt.
   */
  legacy?: ArtifactLegacyFormatReport;
}

/**
 * Where the daemon found the trust grant that authorized injection.
 */
export type ArtifactTrustScopeType = 'self' | 'instance' | 'author' | 'artifact' | 'session';

/**
 * Trust state attached to a payload.
 */
export type ArtifactTrustState = 'self' | 'trusted' | 'untrusted' | 'no_secrets_needed';

/**
 * Console log entry from Sandpack runtime (captured in browser, sent to daemon)
 */
export interface ArtifactConsoleEntry {
  timestamp: number;
  level: 'log' | 'warn' | 'error' | 'info';
  message: string;
}

/**
 * Sandpack bundler/runtime error captured from the browser iframe.
 * These errors (e.g. "Could not find module './data'") happen inside
 * Sandpack's bundler before any user JS executes, so they never reach
 * console.error and are invisible to console_logs.
 */
export interface SandpackError {
  message: string;
  title?: string;
  path?: string;
  line?: number;
  column?: number;
}

/**
 * Full artifact status returned to agents via MCP
 */
export interface ArtifactStatus {
  artifact_id: ArtifactID;
  /** Reflects file validation AND Sandpack runtime state.
   *  If Sandpack reports an error, this is overridden to 'error'
   *  even if file validation passed. */
  build_status: ArtifactBuildStatus;
  build_errors?: string[];
  /** Sandpack bundler/runtime error from the browser iframe (null = no error) */
  sandpack_error?: SandpackError | null;
  /** Sandpack bundler status: 'idle', 'running', 'timeout', etc. */
  sandpack_status?: string;
  /** ISO timestamp for the latest current-content browser runtime report from this viewer. */
  runtime_observed_at?: string;
  console_logs: ArtifactConsoleEntry[];
  content_hash?: string;
}

/**
 * A persisted trust grant. The viewer (`user_id`) consented to inject the
 * listed `env_vars_set` and `agor_grants_set` into one or more artifacts
 * matching `scope_type` + `scope_value`.
 *
 * Soft-deleted via `revoked_at` for audit history.
 */
export interface ArtifactTrustGrant {
  grant_id: UUID;
  user_id: UserID;
  scope_type: ArtifactTrustScopeType;
  /**
   * Resolves per scope_type:
   * - 'artifact'  → ArtifactID
   * - 'author'    → UserID (artifact author)
   * - 'instance'  → null
   * - 'session'   → in-memory only; never persisted with this row shape
   * - 'self'      → never persisted (viewer-is-author bypass)
   */
  scope_value: string | null;
  env_vars_set: string[];
  agor_grants_set: AgorGrants;
  granted_at: string;
  revoked_at?: string;
}

/**
 * Result of `detectLegacyFormat()`. Surfaces in the artifact payload so the
 * UI can render the upgrade banner. The `upgrade_instructions` string is
 * fully interpolated for this specific artifact and ready to hand to an
 * agent.
 */
export interface ArtifactLegacyFormatReport {
  is_legacy: boolean;
  signals: ArtifactLegacySignal[];
  /** Env var names parsed out of `{{ user.env.X }}` references. */
  detected_env_vars: string[];
  /** Grant keys parsed out of `{{ agor.X }}` references. */
  detected_grants: string[];
  /** Pre-formatted prompt the user can hand to an agent for self-service upgrade. */
  upgrade_instructions: string;
}

export type ArtifactLegacySignal =
  | 'has_sandpack_json'
  | 'has_agor_config_js'
  | 'no_sandpack_config'
  | 'has_handlebars_agor_grant'
  | 'has_handlebars_user_env'
  | 'has_handlebars_user_email'
  | 'has_handlebars_artifact_ref';

/**
 * Output of the one-shot artifact review LLM call. Surfaces inline as inline
 * badges on the file tree in the consent modal.
 */
export interface ArtifactReviewReport {
  summary: string;
  concerns: ArtifactReviewConcern[];
}

export interface ArtifactReviewConcern {
  severity: 'low' | 'med' | 'high';
  file: string;
  line?: number;
  note: string;
}
