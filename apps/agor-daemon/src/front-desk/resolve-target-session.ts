/**
 * The one place that decides which session an inbound address reaches.
 *
 * Teammate-to-teammate addressing calls this today; gateway inbound routing is
 * meant to call the same function once gateway front desks ship, which is why
 * `FrontDeskScope` already carries the gateway shape. Two copies of this
 * precedence is the predictable failure mode — keep it one.
 *
 * Precedence, in order, no exceptions:
 *   1. an explicitly named session;
 *   2. an existing gateway thread mapping (gateway only — not yet wired);
 *   3. the declared front-desk slot, if it passes the health gate;
 *   4. recency — Part 1's most-recently-updated pick;
 *   5. `needs_session`.
 *
 * This is addressing, not authorization. It never promotes, and the only write
 * it performs is demoting a slot the health gate rejects — after which it
 * falls through to recency, so a broken front desk degrades to exactly the
 * behavior that existed before front desks, never to nothing. A `dryRun`
 * resolution skips that write and only reports the slot it passed over, so a
 * preview (`agor_teammates_resolve`) walks the same precedence without side
 * effects. Whoever sends the prompt still authorizes it downstream.
 */

import {
  BranchFrontDeskRepository,
  SessionRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import {
  type BranchFrontDeskID,
  type BranchFrontDeskSession,
  type BranchID,
  FRONT_DESK_GATEWAY_SCOPE_PREFIX,
  FRONT_DESK_PRIMARY_SLOT,
  FRONT_DESK_TEAMMATE_SCOPE,
  type FrontDeskRetiredReason,
  type FrontDeskScopeKey,
  type FrontDeskStatus,
  type GatewayChannelID,
  type Session,
  type SessionID,
  type Task,
  TaskStatus,
  type UserID,
} from '@agor/core/types';

export type FrontDeskScope =
  | { kind: 'teammate' }
  | { kind: 'gateway'; channelId: GatewayChannelID; threadId: string };

/** Why resolution found nothing to talk to. */
export type FrontDeskMissReason = 'no_session';

/**
 * A declared front desk the health gate rejected, so resolution fell through
 * to recency. `demoted` is whether this resolution won the demotion write —
 * always false for a dry run, and false when a concurrent resolver won it.
 */
export interface BypassedFrontDesk {
  frontDeskId: BranchFrontDeskID;
  sessionId: SessionID;
  status: FrontDeskStatus;
  demoteTo: Extract<FrontDeskStatus, 'retired' | 'failed'>;
  reason: FrontDeskRetiredReason;
  demoted: boolean;
}

export type FrontDeskTarget =
  | { via: 'explicit'; sessionId: SessionID }
  | { via: 'thread_mapping'; sessionId: SessionID; mappingId: string }
  | {
      via: 'front_desk';
      sessionId: SessionID;
      slot: number;
      frontDeskId: BranchFrontDeskID;
      session: Session;
    }
  | {
      via: 'recency';
      sessionId: SessionID;
      session: Session;
      bypassedFrontDesk?: BypassedFrontDesk;
    }
  | {
      via: 'needs_session';
      branchId: BranchID;
      reason: FrontDeskMissReason;
      bypassedFrontDesk?: BypassedFrontDesk;
    };

export interface ResolveTargetSessionInput {
  branchId: BranchID;
  /** Recorded for the eventual gateway caller; authorization stays downstream. */
  callerUserId: UserID;
  scope: FrontDeskScope;
  explicitSessionId?: SessionID;
  /** Report an unhealthy front desk instead of demoting it. */
  dryRun?: boolean;
}

export interface ResolveTargetSessionDeps {
  /** Run database reads inside the caller's trusted tenant scope. */
  read<T>(work: (db: TenantScopeAwareDatabase) => Promise<T>): Promise<T>;
  /** Run a (demotion) write inside the caller's trusted, write-gated tenant scope. */
  write<T>(work: (db: TenantScopeAwareDatabase) => Promise<T>): Promise<T>;
  /**
   * Part 1's recency pick for the branch, through the caller's own
   * access-scoped read path. Returning the session keeps that path — and its
   * ordering and tie-breaker — the single definition of "recency".
   */
  mostRecentSession(branchId: BranchID): Promise<Session | null>;
}

/** Map a resolution scope onto the persisted slot discriminator. */
export function frontDeskScopeKey(scope: FrontDeskScope): FrontDeskScopeKey {
  return scope.kind === 'teammate'
    ? FRONT_DESK_TEAMMATE_SCOPE
    : `${FRONT_DESK_GATEWAY_SCOPE_PREFIX}${scope.channelId}`;
}

/**
 * Whether a settled Task records the executor dying rather than the agent
 * answering badly. Supervision (dispatch deadline, lost heartbeat, SDK
 * watchdog, unverified containment) always stamps `sdk_failure`; an ordinary
 * agent error never does.
 */
export function isExecutorLifecycleFailure(task: Pick<Task, 'status' | 'sdk_failure'>): boolean {
  return task.status === TaskStatus.FAILED && task.sdk_failure !== undefined;
}

interface HealthVerdict {
  healthy: boolean;
  session?: Session;
  demoteTo?: Extract<FrontDeskStatus, 'retired' | 'failed'>;
  reason?: FrontDeskRetiredReason;
}

/**
 * The health gate. Rejects the pinned session when it is gone, archived,
 * outside the branch, dead, or a `retiring` slot with nothing left in flight.
 *
 * Not checked yet: `fork_origin === 'btw'`. `rowToSession` does not project
 * `fork_origin`, so the check would be silently always-false; it lands with
 * the projection fix, which is why it is absent rather than half-present.
 */
async function assessFrontDesk(
  db: TenantScopeAwareDatabase,
  desk: BranchFrontDeskSession,
  branchId: BranchID
): Promise<HealthVerdict> {
  const session = await new SessionRepository(db).findById(desk.session_id);
  if (!session || session.archived) {
    return { healthy: false, demoteTo: 'retired', reason: 'archived' };
  }
  if (session.branch_id !== branchId) {
    return { healthy: false, demoteTo: 'retired', reason: 'replaced' };
  }
  const tasks = new TaskRepository(db);
  const lastOutcome = await tasks.findLastSettledOutcome(desk.session_id);
  if (lastOutcome && isExecutorLifecycleFailure(lastOutcome)) {
    return { healthy: false, demoteTo: 'failed', reason: 'dead' };
  }
  // `retiring` keeps serving while a turn is in flight: retiring mid-thread
  // would strand the conversation it is still answering.
  if (desk.status === 'retiring' && !(await tasks.hasNonterminalForSession(desk.session_id))) {
    return { healthy: false, demoteTo: 'retired', reason: 'context' };
  }
  return { healthy: true, session };
}

export async function resolveTargetSession(
  input: ResolveTargetSessionInput,
  deps: ResolveTargetSessionDeps
): Promise<FrontDeskTarget> {
  if (input.explicitSessionId) {
    return { via: 'explicit', sessionId: input.explicitSessionId };
  }

  if (input.scope.kind === 'gateway') {
    // Precedence rule 2 (an existing thread keeps its session forever) must
    // land with the gateway caller itself. Refusing here keeps a gateway
    // caller from silently skipping it.
    throw new Error('Gateway front-desk resolution is not enabled');
  }

  const ref = {
    branchId: input.branchId,
    scope: frontDeskScopeKey(input.scope),
    slot: FRONT_DESK_PRIMARY_SLOT,
  };
  const pinned = await deps.read(async (db) => {
    const desk = await new BranchFrontDeskRepository(db).findOccupant(ref);
    return desk ? { desk, verdict: await assessFrontDesk(db, desk, input.branchId) } : null;
  });

  if (pinned?.verdict.healthy && pinned.verdict.session) {
    return {
      via: 'front_desk',
      sessionId: pinned.desk.session_id,
      slot: pinned.desk.slot,
      frontDeskId: pinned.desk.id,
      session: pinned.verdict.session,
    };
  }

  let bypassedFrontDesk: BypassedFrontDesk | undefined;
  if (pinned?.verdict.demoteTo && pinned.verdict.reason) {
    const { desk } = pinned;
    const demoteTo = pinned.verdict.demoteTo;
    const reason = pinned.verdict.reason;
    // Conditional on the status just read, so concurrent resolvers converge:
    // one wins, the rest see zero rows and fall through the same way.
    const won =
      !input.dryRun &&
      (await deps.write((db) =>
        new BranchFrontDeskRepository(db).demote({
          id: desk.id,
          expectedStatus: desk.status,
          toStatus: demoteTo,
          reason,
        })
      ));
    if (won) {
      console.warn(
        `[front-desk] demoted front_desk_id=${desk.id} from=${desk.status} to=${demoteTo} reason=${reason} fallback=recency`
      );
    }
    bypassedFrontDesk = {
      frontDeskId: desk.id,
      sessionId: desk.session_id,
      status: desk.status,
      demoteTo,
      reason,
      demoted: won,
    };
  }

  const recent = await deps.mostRecentSession(input.branchId);
  if (!recent) {
    return {
      via: 'needs_session',
      branchId: input.branchId,
      reason: 'no_session',
      ...(bypassedFrontDesk ? { bypassedFrontDesk } : {}),
    };
  }
  return {
    via: 'recency',
    sessionId: recent.session_id,
    session: recent,
    ...(bypassedFrontDesk ? { bypassedFrontDesk } : {}),
  };
}
