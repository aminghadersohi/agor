# Artifact interaction bindings

Status: implemented on `feat/action-chat-artifacts`

## Problem

Artifacts are author-written JavaScript running in a Sandpack iframe. Authors
want small tools Agor does not ship: a panel showing whether a schedule is
armed, buttons that run it once or disarm it, and a chat surface pointed at a
chosen session that can later be repointed somewhere else.

The obvious way to enable that is also the wrong way. `window.agor.callApi(url)`
or `window.agor.callMcp(tool, args)` would let an artifact do anything the
person looking at it can do — which makes every artifact a confused deputy, and
makes reviewing an artifact equivalent to reviewing arbitrary code with the
viewer's credentials. This document describes what we built instead.

## The invariant

Everything below follows from one rule:

> Artifact JavaScript supplies an opaque, artifact-local **binding id** and
> nothing else. Everything that determines what actually happens — which
> schedule, which session, which fields, whether a flag becomes true or false —
> is persisted server-side and was validated against the artifact's source
> branch when the author declared it. The parent page then calls the ordinary
> authenticated route with the _viewer's_ credentials.

Two consequences carry the whole design.

**An artifact is a shortcut, not a capability.** Every binding resolves to a
request the viewer could have made by hand in the Agor UI. If they could not do
it by hand, the binding fails with the same error. An artifact never grants
authority; it only saves clicks.

This is load-bearing rather than aspirational. `POST /schedules/:id/run-now`
runs `ensureScheduleRunsAsCaller`
(`apps/agor-daemon/src/utils/schedule-hooks.ts:138`) and
`scheduler.executeScheduleNow` re-checks `schedule.created_by !== triggeredBy`
(`apps/agor-daemon/src/services/scheduler.ts:741`). A non-creator clicking an
artifact button gets `403`, not someone else's agent session. `PATCH
/schedules/:id` is gated the same way by `ensureCanModifySchedule` plus
`ensureScheduleRunsAsCaller` (`apps/agor-daemon/src/register-hooks.ts:3398`). We
inherit all of it by routing through those services rather than reimplementing
them.

**A binding may only name a resource inside the artifact's source branch.**
This bounds the blast radius: author and viewer are reasoning about the same
branch, so a read cannot carry data across a trust boundary the branch does not
already span. It is also the line that decides what is bindable at all — see
the MCP discussion below.

## Binding schema

Three families share one envelope and are persisted under
`agor_runtime.interactions`:

```ts
interface ArtifactBindingBase {
  id: string; // the only thing artifact JS ever supplies
  label: string;
  description?: string;
}

// READ — window.agor.fetchData(id)
interface ArtifactDataBinding extends ArtifactBindingBase {
  source: ArtifactDataSource;
}
type ArtifactDataSource =
  | { kind: 'schedule_status'; schedule_id: ScheduleID }
  | { kind: 'session_status'; session_id: SessionID };

// WRITE — window.agor.runAction(id)
interface ArtifactActionBinding extends ArtifactBindingBase {
  effect: ArtifactActionEffect;
  confirm?: boolean;
}
type ArtifactActionEffect =
  | { kind: 'schedule_run'; schedule_id: ScheduleID }
  | { kind: 'schedule_set_enabled'; schedule_id: ScheduleID; enabled: boolean };

// CHAT — window.agor.openChat(id)
interface ArtifactChatBinding extends ArtifactBindingBase {
  session_id: SessionID;
}

interface ArtifactInteractionConfig {
  actions?: ArtifactActionBinding[];
  data?: ArtifactDataBinding[];
  chats?: ArtifactChatBinding[];
}
```

`effect` and `source` are discriminated unions, so a new kind is an added
variant rather than a schema migration.

`schedule_set_enabled` pins `enabled` at declaration time. A toggle is therefore
two declared bindings ("Arm" and "Disarm"), not one binding with a
caller-supplied boolean.

Chats are a named set rather than a single session id so a widget can offer more
than one conversation, and so an author can retire a conversation and point the
same widget at a replacement with a metadata patch instead of republishing code.

## Authority model

|                | What names it                 | Who executes                                     | What is pinned                        | Enforced where                          |
| -------------- | ----------------------------- | ------------------------------------------------ | ------------------------------------- | --------------------------------------- |
| Data binding   | `id` (opaque, artifact-local) | Viewer, via `schedules`/`sessions` service `get` | Resource id, kind, response field set | `GET /artifacts/:id/data/:dataId`       |
| Action binding | `id` (opaque, artifact-local) | Viewer, via `run-now` / `PATCH schedules`        | Resource id, kind, **every argument** | `POST /artifacts/:id/actions/:actionId` |
| Chat binding   | `id` (opaque, artifact-local) | Parent page opens the existing session surface   | Session id                            | Payload filter + branch view check      |

**What the iframe can name:** a string that already exists as a declared binding
id in the artifact's persisted metadata. Nothing else. It cannot name a tool, a
route, a schedule, a session, a branch, a field, or an argument.

**Zero caller-supplied arguments.** Arguments could have been allowed under a
declared schema with an explicit allowlist. We pin instead, because every
capability in scope — show a schedule's state, run it once, arm it, disarm it,
open a named chat — needs no runtime argument, and a zero-argument surface has
no injection surface to specify, validate, review, or get wrong later. The
unions leave room to add a `params_schema` to a _specific future kind_ if a real
need appears; adding a general argument channel now would mean carrying its
validation cost forever to serve no caller.

**Reads cannot write, structurally.** The three families are separate arrays,
not one list discriminated by `kind`. A read id simply does not exist in the
actions collection, so `resolveBindingTarget(id, 'action')` finds nothing —
rather than finding something and relying on a kind check that a later edit
could forget. The two transports are separate too: reads are a `GET` with no
body, writes a `POST`. "Is this call read-only?" is never a question answered at
runtime.

**Server-side projection.** The data route does not return the resource; it
returns a hardcoded subset.

- `schedule_status` → `schedule_id, name, enabled, cron_expression, timezone, timezone_mode, next_run_at, last_run_at, last_run_session_id, allow_concurrent_runs`
- `session_status` → `session_id, title, status, agentic_tool, archived, last_updated`

`prompt`, `agentic_tool_config`, and `created_by` are deliberately absent.
Widening a projection is an edit to an explicit list, which is the point.

**Validation happens twice.** Declaration time (`validateInteractionConfig`)
rejects a binding whose referenced schedule/session is missing or on another
branch. Execute time re-resolves the binding from the persisted artifact and
re-checks branch identity before dispatching. The `interaction_config` in the
payload is a rendering hint; it is never the authority for what executes.

The drift the second check actually catches is _deletion_, not relocation:
`ScheduleRepository.update` pins `branch_id: current.branch_id` with the comment
"never reparent" (`packages/core/src/db/repositories/schedules.ts:358`). Keeping
the branch assertion at execute time anyway costs one indexed read and means the
invariant does not depend on that comment staying true.

**RBAC is delegated, not reimplemented.** Both routes call the real service with
the viewer's `user` **and a preserved `provider`**. This matters: several Agor
hooks short-circuit on `if (!context.params.provider) return context`
(`schedule-hooks.ts:140`), treating provider-less calls as trusted internal
ones. Dropping `provider` here would silently disable exactly the checks we are
relying on, so it is preserved explicitly and covered by a test.

**Sanitize on write and on read.** `sanitizeArtifactInteractionConfig` runs at
both ends, so it _is_ the definition of the canonical shape: anything it drops
is something no payload, route, or UI ever sees. A binding it cannot fully
resolve from persisted metadata is dropped entirely rather than partially
honored — the missing piece would have to come from somewhere at call time, and
the only "somewhere" available is the iframe.

**Payload filtering mirrors trust handling elsewhere.** Bindings are stripped
from `interaction_config` when the viewer cannot `view` the artifact's source
branch, so a widget renders an unavailable state instead of discovering a `403`
at click time. This is a UX affordance; the route check is the authority.

### Relationship to the TOFU consent surface

`required_env_vars` and `agor_grants` gate _secret injection_: the author's code
receives something the viewer holds, so the viewer must consent first.

Bindings deliberately do not join that surface, and the reason is the branch
invariant. A binding can only name a resource on the artifact's source branch,
and it executes with the viewer's own authority — so the artifact reads exactly
what both parties can already read, and writes only what the viewer could write
by hand. There is no privilege gradient for consent to protect. The moment a
binding could reach _outside_ the branch — an MCP server, an arbitrary URL — that
stops being true, which is precisely why those are not bindable.

### Known residual risk: stale author

If an author publishes an artifact and later loses access to its branch, their
JavaScript can still read same-branch data through a viewer who retains access.
The window is bounded — non-secret projections, no cross-branch reach, writes
still creator-only — but it is real. Revoking branch access does not currently
archive artifacts published from that branch.

## Rejected alternatives

**`window.agor.callMcp(toolName, args)`.** The confused deputy in pure form:
author-chosen tool, author-chosen arguments, viewer's credentials. An artifact
bound to a session-prompt or branch-archive tool would execute against the
viewer's authority. Rejected outright.

**MCP data bindings (pinned tool, pinned args, viewer's credential).** Rejected,
and this one deserves the full reasoning because it is the most plausible-looking
of the rejected designs.

1. _The read/write distinction is not derivable._ A data binding must not be
   able to invoke a mutating tool. For an external MCP server the only available
   signal is `annotations.readOnlyHint`, supplied by the remote server — untrusted
   input describing itself. Agor already uses it exactly once, in
   `probeMcpAuthViaReadOnlyToolCall`
   (`apps/agor-daemon/src/register-services.ts:3332`), and there it is a
   _politeness_ during an **unauthenticated** probe, explicitly not a security
   boundary. Building a credentialed read boundary on a self-declared hint would
   invent a guarantee the protocol does not provide.
2. _The response lands in author-controlled JavaScript with network egress._
   Unlike a schedule run, whose output stays in a session, a data binding returns
   its result into the iframe. Executing with the viewer's per-user OAuth grant
   means the author's code reads the viewer's third-party account and can
   exfiltrate it — strictly worse than `required_env_vars`, where the viewer
   consents to a _named_ secret with an understandable blast radius.
3. _Executing with the author's credential instead is the same confused deputy,
   inverted._ Agor has no delegation primitive that would make it reviewable.
4. _It breaks the branch invariant_, and with it the argument in "Relationship to
   the TOFU consent surface" above.
5. _The daemon cannot do it today anyway._ Daemon-side MCP is limited to
   `initialize` / `tools/list` / `resources/list` / `prompts/list` during
   discovery (`register-services.ts:4900+`). Tool invocation belongs to executors
   inside sessions, mediated by the egress gateway. Adding one would be a new
   credentialed egress path, not a small extension.

_Safe alternative, which costs nothing to adopt:_ MCP already has a correct home
— inside the schedule's agent session. An action binding runs a schedule whose
agent has the MCP server attached, under an author-written prompt, as the
schedule's creator, recorded as a session. To surface MCP _data_ in a widget,
have that schedule write its result somewhere branch-scoped and readable and
point a data binding at that. The trust boundary stays where it is already
reviewed.

**A generic allowlisted internal read (`{ kind: 'api_get', path }`).** Rejected:
it makes the iframe's binding name a _route_, so the safety of the result then
depends on per-route response shapes that change independently of this feature.
Named kinds with fixed projections keep the reviewable surface in one file.

**One `bindings[]` array discriminated by `kind`.** Tidier on paper, weaker in
practice. Separate collections are what make "a data binding cannot reach a
mutating dispatch" true by construction; a single array reduces it to a runtime
`kind` check sitting between an attacker and a schedule.

**Rendering the chat surface inside the iframe.** Not possible without giving the
iframe a token, which is the one thing the model forbids. `openChat(id)` opens
the existing session surface in the parent with its full controls. The widget can
render its own header from `session_status` data.

## Worked example

[`examples/release-console-artifact.md`](examples/release-console-artifact.md) —
a single-file static artifact with one data binding, three action bindings (run
/ arm / disarm against one schedule), and a chat binding, plus the publish call
that declares them. Fictional data only.

## Configuration surface

Bindings are authored through the existing MCP tools — `agor_artifacts_publish`
and `agor_artifacts_update` both take `interactionConfig`. Short ids are
resolved to full ids by the same `resolveScheduleId` / `resolveSessionId`
helpers used elsewhere in those tools. No new authoring surface: an agent that
can publish an artifact can declare its bindings in the same call.
