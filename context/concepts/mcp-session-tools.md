# MCP session tools

> User-facing reference: [`apps/agor-docs/content/guide/internal-mcp.mdx`](../../apps/agor-docs/content/guide/internal-mcp.mdx).
> Tool handlers: `apps/agor-daemon/src/mcp/tools/sessions.ts`. Tests: `sessions.test.ts` next door.

The MCP-exposed surface for managing sessions, distinct from the broader `agor_*` toolset (boards, branches, repos, environments).

## Built-in transport boundary

`apps/agor-daemon/src/mcp/server.ts` exposes one stateless Streamable HTTP
endpoint using the stable TypeScript MCP SDK v2. Each `POST /mcp` authenticates
and reconstructs tenant, user, and optional Agor Session context, creates a
fresh request-local SDK server/transport, and closes it when that exchange
finishes. Shared immutable tool metadata is cached; authenticated context is
never cached. The endpoint issues no `Mcp-Session-Id`, retains no transport
Map/timer, and returns 405 for authenticated GET and DELETE requests
(authentication runs first).
User-configured external MCP servers are a separate capability passed to
executors and are not proxied by this endpoint.

One SDK handler serves both protocol eras from the same server factory:

- `2026-07-28` clients use the modern, handshake-free per-request metadata
  contract and may call `server/discover`. Ordinary results are bounded JSON.
- Initialization-era clients through `2025-11-25` use the SDK's stateless
  compatibility arm. `initialize`/`notifications/initialized` still work, but
  no transport Session is created. A request result may use one bounded,
  request-scoped SSE response to preserve the legacy wire contract.

The modern protocol's `server/discover` and cache hints improve protocol and
catalog discovery, but they do not define semantic search across a large tool
catalog. With `mcp_tool_search` enabled, Agor therefore still exposes only
`agor_search_tools`, `agor_get_tool_details`, and `agor_execute_tool` through
`tools/list`; domain tools live in a request-local Agor dispatcher behind that
facade. This preserves domain filtering and concise schemas without reaching
into SDK-private registration state.

## Workflow and transfer tools

1. **`agor_sessions_prompt`** — continue, fork, or spawn from an existing session. `mode: 'continue' | 'fork' | 'subsession'`.
2. **`agor_sessions_create`** — new session in a specified branch. Optional `initialPrompt`, agent override, permission mode.
3. **`agor_sessions_update`** — rename, change status, refresh description.
4. **`agor_sessions_retarget_callback`** — move one existing standing/direct
   completion route. It atomically updates matching `remote_create`
   relationship rows but does not touch genealogy.
5. **`agor_sessions_reparent`** — change only branch-local
   `parent_session_id`, including detaching to a root. It does not touch
   callback routing or remote relationships.
6. **`agor_session_relationships_relay`** — relay from the current MCP Session
   to an explicitly selected `parent` or current `coordinator`. It accepts no
   target Session ID.
7. **`agor_sessions_interrupt_with_message`** — a current branch-local parent
   or enabled direct callback coordinator stops its child and queues one
   correction at highest priority. The target is supplied, but authority is
   derived from the target's current durable relationship and rechecked at the
   admission fence. A caller-stable `idempotencyKey` converges retries.

All enforce the branch-centric model (every session references a branch). Permission modes map to each agent's native settings.

`agor_sessions_prompt` also accepts `callback: true`. The daemon binds this
one-shot request to the exact task created by the prompt and derives the
destination from trusted current-session MCP context; callers cannot nominate
an arbitrary destination. Task-level and existing session-level callbacks keep
independent lifecycle semantics, while equal source-task/destination events are
coalesced by a database uniqueness constraint. Delivery remains best-effort if
the daemon exits after terminalizing the source task but before callback task
creation.

For work that may be delegated again, use `callbackPropagation: "root"`
instead. This creates a durable completion subscription and returns its ID. A
downstream agent transfers that exact requested unit of work by setting
`continueCompletion: true` on `agor_sessions_prompt`, `agor_sessions_create`,
or `agor_sessions_spawn`. Only one child can be designated at each hop; other
parallel children are helpers and do not delay or complete the aggregate. The
intermediary's completion is suppressed for the root recipient after a handoff,
and the designated terminal Task delivers exactly one queued callback. Query
the aggregate with `agor_completion_subscriptions_get`. See
[`transitive-completion-propagation.md`](../explorations/transitive-completion-propagation.md)
for lifecycle, failure, retry, privacy, and rollback semantics.

Callbacks enabled by `agor_sessions_create` default to `persistent`; use
`callbackMode: "once"` for a single report. Durable remote relationships can
be muted or resumed with `agor_session_relationships_set_callback` without
deleting the relationship. Spawned child and `btw` callbacks remain one-shot.

Standing callback retargeting preserves the callback's enabled state, mode,
template, and include flags. Completion dispatch reloads the Session after the
terminal Task commit, so a Task that was already running when the transfer
committed follows only the new standing destination. The immutable
`Task.metadata.completion_callback` written by `agor_sessions_prompt` with
`callback:true` is a separate exact-Task subscription (including subscriptions
originating from a root orchestrator). Retargeting never rewrites it; if it
names another destination, that independently requested report is still sent.

Genealogy reparenting requires an active same-branch destination and rejects a
Session itself or any of its descendants. Both operations require Manager
authority over the source, normal prompt authority over a non-null destination,
and one tenant throughout.

Current-context introspection calls provenance and control different things on
purpose. `remote_origins` is the immutable set of `remote_create` sources;
`parent_session_id` is the current branch-local parent; and
`effective_direct_callback_coordinator_session_id` is the enabled standing
route. Retargeting changes the coordinator field and coordinator relay target,
while reparenting changes the parent field and parent relay target. The relay
tool resolves these durable values on each call, requires an explicit selector
when both exist, rechecks destination prompt authority/tenant/state, and never
uses a caller-supplied Session ID.

Interrupt-with-message requires source visibility, current relationship
membership, normal prompt authority on the active target, an active same-tenant
Session/branch, and the current authenticated human actor. Archived/deleted
targets fail closed. Idle targets receive the correction without a synthetic
Stop. Running, dispatching, awaiting-permission, and legacy awaiting-input Tasks
enter the existing safe Stop lifecycle; the correction stays queued through
pending/unverified containment and starts only after verified settlement. A
stopped Task does not emit natural-completion callbacks; later successful
completion of the corrective Task follows its normal standing/root callback
rules. Task-scoped executor authority is retired only by normal terminal
settlement, never by interrupt admission.

## Overrides at create/spawn/subsession time

`agor_sessions_create`, `agor_sessions_spawn`, and `agor_sessions_prompt` with `mode: "subsession"` all accept:

- **`modelConfig`** — `{ model: string, mode?: 'alias' | 'exact', effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max', provider?: string }`. `model` is required when the object is provided. Threaded into `session.model_config` and consumed by `packages/executor/src/sdk-handlers/claude/query-builder.ts`.
- **`mcpServerIds`** — pins which MCP servers attach. `[]` = no MCPs. Omit to inherit (branch → parent → user default). Failed attachments surface as `mcpAttachFailures: [{ mcp_server_id, reason }]` in the response (not silently logged).

## Security note for spawn/fork

Creating a new session attributes that new conversation to the caller. Continuing
an existing foreign-owned branch-home conversation requires
`sessions.prompt_own`, the tenant workspace preference, and the effective
branch sharing switch. The conversation and branch SDK state are preserved,
while the task, execution home, managed credentials, MCP visibility, and
branch filesystem projection use the actual caller. Execution-home Sessions
are never shareable. See
[`context/explorations/session-sharing.md`](../explorations/session-sharing.md).
