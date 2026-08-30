# Task Queueing

**Tasks are the queueable unit. Sessions accept prompts. PostgreSQL is the
durable authority for admission, ordering, and dispatch across daemons.**

## Wire shape

`POST /sessions/:id/prompt` always returns the persisted `Task`. Callers inspect:

- `task.status === 'queued'` — the task has a durable position and is waiting;
- `task.status === 'dispatching'` — launch intent is durable and an executor is
  being started;
- `task.status === 'running'` — the authenticated executor claimed the task;
- `task.queue_position` — ordering within the Session queue (lowest first),
  populated only while `queued`.

There is no separate “queued vs ran” envelope and no `queue: true` request flag.
The response is the result of the admission attempt, not a decision based on a
client's earlier Session GET.

## Durable admission and dispatch

1. **Admit** — every prompt first creates a `queued` Task. While holding a
   short lock on the owning Session row, `TaskRepository.createPending`
   assigns `max(queue_position) + 1`. The Session row is the per-queue
   sequencer; an ordinary transaction without this lock is insufficient under
   PostgreSQL `READ COMMITTED`. A partial unique index is defense in depth.
   The prompt endpoint carries tenant identity through a long-route scope;
   admission itself is a bound short repository unit, so the Session lock is
   released before title/config work, claim preparation, or event delivery.
2. **Attempt the head** — the prompt route immediately offers that Task to
   `spawnTaskExecutor`. If the Session is promptable and the Task is the
   durable queue head, it may leave the queue without waiting for a later scan.
   Otherwise the route returns the still-queued Task and its actual position.
3. **Claim** — `claimDispatchAndProjectSession` locks Session first, then Task,
   and atomically checks the queue head, absence of another executing Task,
   Session promptability, and the expected Task state. The winning transaction
   writes `queued|created -> dispatching` and the Session's running projection.
4. **Launch after commit** — only `outcome: 'claimed'` may schedule executor
   launch (a loser may only perform deterministic transcript repair after the
   winner has crossed the fence). No transaction is held while spawning an
   executor or doing external work. The authenticated executor later claims
   `dispatching -> running`.

`created` remains supported for the explicit `POST /tasks/:id` then
`POST /tasks/:id/run` workflow. It cannot jump an existing queued prompt or a
different executing Task.

## Fleet-wide draining and recovery

Every daemon runs a bounded `SessionQueueWorker`. It discovers routing-only
queued Session refs and then reloads/processes each Session inside its trusted
tenant scope. There is no permanent leader and no worker lease: overlapping
scans are expected, while the Session+Task claim elects the only launcher.

Ordinary draining is event-driven by the committed terminal/Session projection.
The worker is a missed-event and restart recovery sweep, not a low-latency poller:
it pages quickly through at most 250 Session refs per sweep, preserves its
keyset cursor when saturated, then waits about one minute before continuing. A
known-busy queue head is therefore not fully hydrated every few seconds, while
a missed wakeup remains durably recoverable.

The scan cursor, startup offset, bounded backoff, and jitter are contention
etiquette and fairness only. A process-local `SessionTurnLocks` map and
`queueRetryScheduled` set similarly coalesce work inside one daemon; process
death or duplicate triggers cannot affect correctness.

Queued rows survive daemon restart. Completion, Stop, callbacks, widgets,
scheduled initialization, and the recovery worker may all trigger draining;
duplicate triggers converge at the same durable claim. Callback and widget
occurrences use deterministic Task IDs so competing producers converge on one
queued row and one position. Their stable initial-message identity is persisted
in `Task.metadata.initial_message_id`; a later drainer therefore writes exactly
the same transcript row. A losing admission that still observes `queued` writes
no transcript row.

Widget submit/dismiss uses a separate short Message-row claim before registry
or connector work. Only `pending -> resolving` may perform that work; the
opaque claim token alone may publish `submitted|dismissed`. An interrupted
attempt remains durably `resolving` and is not replayed automatically because
the prior side effect may already have happened. Only an `applySubmit` handler
that explicitly reports failure before returning releases the widget to
`pending` with a secret-free failure code for an explicit retry; handlers must
make that reported-error retry idempotent. Prompt-admission or completion
failures after `applySubmit` succeeds leave the claim `resolving` so the effect
cannot be replayed. Widget creation and lifecycle metadata are daemon-owned:
generic external Message create/update/patch cannot mint or alter a widget,
and pending/resolving widgets cannot be externally removed.

## Ordinary prompt compaction

Busy Sessions compact only the contiguous queue tail made entirely of safe,
ordinary prompts from the same execution actor with identical permission and
stream controls. Admission holds the same Session row lock as queue numbering,
so a dispatcher and another daemon cannot fold into a Task after its
`queued -> dispatching` claim. Every originating request remains visible in
`Task.metadata.prompt_compaction.requests`; normalized duplicates retain their
request ID, author, time, and original text but do not repeat bytes sent to the
agent. Normalization is deterministic (Unicode NFKC, LF line endings, trimmed
lines, collapsed horizontal whitespace and excess blank lines), never semantic
or LLM-based.

Combined executor prompts are capped at 32 KiB UTF-8. The next distinct prompt
that would exceed the cap starts the next queue chunk; a single oversized
prompt remains intact as its own Task. There is no truncation. Internal stable
producers, exact-Task callbacks, standing/genealogy continuations, callbacks,
widgets, gateways, interrupt corrections, attachment-bearing prompts, slash
controls, different actors, and different execution controls are barriers.
These exclusions preserve stable Task/message identity, one-result-per-request
callback contracts, attachment lifecycle, credential attribution, and control
ordering. Queue/status responses expose the admission request ID, shared
execution Task ID, request IDs/count, unique count, and duplicate count.

An authorized interrupt correction is a separate non-compactable Task. It is
inserted ahead of ordinary queued work while the active Task and Session are
atomically moved to STOPPING. It cannot dispatch until the existing termination
coordinator verifies quiescence/absence and settles the stopped Task.

## Invariants

1. At most one Task is in an executing state for a Session.
2. Concurrent enqueue produces one durable order decision per Task.
3. Only the durable queue head may claim dispatch.
4. A Task claim has one winner; losing daemons do not launch.
5. Terminal Task state is immutable.
6. Queue state survives daemon/process loss.
7. System discovery exposes only routing refs; mutation always re-enters the
   discovered tenant scope.
8. SQLite preserves the same user-visible ordering and lifecycle without
   pretending to provide multi-daemon authority.

## Runtime supervision handoff

- Queued Tasks are durable user intent and survive daemon startup in both
  standalone and shared PostgreSQL modes. Replica startup is never a queue
  outcome.
- Shared PostgreSQL startup also leaves active Tasks and their Session
  projection untouched; bounded runtime reconciliation acts only on expired
  dispatch facts, stale executor heartbeats, or existing durable termination
  requests.
- Queue release follows authoritative Task settlement and the resulting
  Session projection. It is not keyed to daemon identity or restart notices.
- Verified containment may make the Session promptable and show a new-Task
  Resume action. Unverified containment remains `stopping` and guarded behind
  owner/admin force-fail.

## Key files

- Persistence: `packages/core/src/db/repositories/tasks.ts`
- Admission/launch/drain: `apps/agor-daemon/src/register-routes.ts`
- Fleet recovery: `apps/agor-daemon/src/services/session-queue-worker.ts`
- Local coalescer: `apps/agor-daemon/src/utils/session-turn-lock.ts`
- Producer identities: `apps/agor-daemon/src/utils/durable-task-id.ts`
- Widget resolution fence: `apps/agor-daemon/src/widgets/resolution-store.ts`
- Reactive client: `packages/client/src/reactive-session.ts`

For post-claim executor lifecycle, heartbeat, SDK pulse/watchdog, and
termination ownership, see [task-runtime-state.md](task-runtime-state.md).
