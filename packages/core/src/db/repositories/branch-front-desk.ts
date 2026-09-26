/**
 * Front-desk slot declarations (`branch_front_desk_sessions`).
 *
 * Every write here is a compare-and-swap. Promotion races are expected — any
 * daemon may promote on a concurrent burst — so correctness rests on two
 * database facts rather than on reading-then-writing:
 *
 * - the partial unique index `uniq_front_desk_slot` admits at most one
 *   `active`/`retiring` row per `(branch, scope, slot)`, so a double promotion
 *   is a constraint violation, never a second front desk;
 * - every status change is `UPDATE … WHERE id = :id AND status = :expected`,
 *   so concurrent demoters converge and exactly one of them wins.
 *
 * Tenant scope is ambient, as for every tenant-owned repository: inserts are
 * stamped from the current tenant context and PostgreSQL row-level security
 * confines every read and write to it. A row in another tenant is simply not
 * found, which is the same answer as "no front desk".
 */

import {
  type BranchFrontDeskID,
  type BranchFrontDeskSession,
  type BranchID,
  FRONT_DESK_OCCUPYING_STATUSES,
  FRONT_DESK_PRIMARY_SLOT,
  type FrontDeskRetiredReason,
  type FrontDeskScopeKey,
  type FrontDeskStatus,
  type SessionID,
  type UserID,
} from '@agor/core/types';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import { lockBranchForAdmission } from '../branch-admission';
import type { Database } from '../client';
import { insert, runDatabaseTransaction, select, update } from '../database-wrapper';
import { isDatabaseUniqueConstraintError } from '../sanitize-error';
import {
  type BranchFrontDeskSessionInsert,
  type BranchFrontDeskSessionRow,
  branchFrontDeskSessions,
  sessions,
} from '../schema';
import { attachHiddenTenant, RepositoryError } from './base';

/** Why a pin was refused before anything was written. */
export type FrontDeskPinRefusal =
  | 'unsupported_slot'
  | 'session_not_found'
  | 'session_archived'
  | 'session_in_other_branch';

/** The request was well-formed but the pin itself is not allowed. */
export class FrontDeskPinRefusedError extends RepositoryError {
  constructor(
    public readonly reason: FrontDeskPinRefusal,
    message: string
  ) {
    super(message);
    this.name = 'FrontDeskPinRefusedError';
  }
}

/**
 * The slot changed underneath the caller: a concurrent promotion won, or the
 * caller's `expectedSessionId` no longer matches. Nothing was written.
 */
export class FrontDeskConflictError extends RepositoryError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'FrontDeskConflictError';
  }
}

function frontDeskFromRow(row: BranchFrontDeskSessionRow): BranchFrontDeskSession {
  return attachHiddenTenant(
    {
      id: row.id as BranchFrontDeskID,
      branch_id: row.branch_id as BranchID,
      scope: row.scope as FrontDeskScopeKey,
      slot: row.slot,
      session_id: row.session_id as SessionID,
      status: row.status as FrontDeskStatus,
      promoted_at: new Date(row.promoted_at).toISOString(),
      promoted_by: (row.promoted_by as UserID | null) ?? undefined,
      retired_at: row.retired_at ? new Date(row.retired_at).toISOString() : undefined,
      retired_reason: (row.retired_reason as FrontDeskRetiredReason | null) ?? undefined,
      metadata: row.metadata ?? undefined,
    },
    row
  );
}

export interface FrontDeskSlotRef {
  branchId: BranchID;
  scope: FrontDeskScopeKey;
  /** Defaults to the primary slot; no other slot is accepted. */
  slot?: number;
}

export interface FrontDeskPromoteInput extends FrontDeskSlotRef {
  sessionId: SessionID;
  promotedBy?: UserID;
  /**
   * Optional CAS guard. `null` means "only if the slot is empty"; a session id
   * means "only if that session currently occupies the slot". Omit to replace
   * whatever is there (still atomically — never two occupants).
   */
  expectedSessionId?: SessionID | null;
}

export interface FrontDeskPromoteResult {
  desk: BranchFrontDeskSession;
  /** The occupant this promotion retired, when there was one. */
  replaced?: BranchFrontDeskSession;
  /** True when the session was already the active occupant; nothing changed. */
  unchanged: boolean;
}

export interface FrontDeskDemoteInput {
  id: BranchFrontDeskID;
  expectedStatus: FrontDeskStatus;
  toStatus: Extract<FrontDeskStatus, 'retired' | 'failed'>;
  reason: FrontDeskRetiredReason;
}

function assertSupportedSlot(slot: number): void {
  if (slot !== FRONT_DESK_PRIMARY_SLOT) {
    throw new FrontDeskPinRefusedError(
      'unsupported_slot',
      `Only front-desk slot ${FRONT_DESK_PRIMARY_SLOT} is supported`
    );
  }
}

export class BranchFrontDeskRepository {
  constructor(private readonly db: Database) {}

  /** The row currently occupying a slot (`active` or `retiring`), if any. */
  async findOccupant(ref: FrontDeskSlotRef): Promise<BranchFrontDeskSession | null> {
    return this.findOccupantIn(this.db, ref);
  }

  /** Every declaration for a branch, newest first — occupants and history. */
  async findByBranch(branchId: BranchID): Promise<BranchFrontDeskSession[]> {
    const rows = await select(this.db)
      .from(branchFrontDeskSessions)
      .where(eq(branchFrontDeskSessions.branch_id, branchId))
      .orderBy(desc(branchFrontDeskSessions.promoted_at), desc(branchFrontDeskSessions.id))
      .all();
    return rows.map(frontDeskFromRow);
  }

  /**
   * Pin `sessionId` into the slot, retiring any current occupant as
   * `replaced` in the same transaction.
   *
   * The session must exist in this tenant, belong to `branchId`, and not be
   * archived. Promoters of one branch serialize on its admission lock; the
   * partial unique index remains the backstop, and a promotion that loses to
   * it surfaces as {@link FrontDeskConflictError} having written nothing.
   */
  async promote(input: FrontDeskPromoteInput): Promise<FrontDeskPromoteResult> {
    const slot = input.slot ?? FRONT_DESK_PRIMARY_SLOT;
    assertSupportedSlot(slot);
    try {
      return await runDatabaseTransaction(
        this.db,
        async (tx) => {
          // Branch-first, like every other branch write: refuses a pin while
          // the branch is being deleted or maintained, and serializes
          // concurrent promoters of the same branch.
          await lockBranchForAdmission(tx, input.branchId);
          const session = await select(tx, {
            branch_id: sessions.branch_id,
            archived: sessions.archived,
          })
            .from(sessions)
            .where(eq(sessions.session_id, input.sessionId))
            .one();
          if (!session) {
            throw new FrontDeskPinRefusedError(
              'session_not_found',
              `Session ${input.sessionId} not found`
            );
          }
          if (session.branch_id !== input.branchId) {
            throw new FrontDeskPinRefusedError(
              'session_in_other_branch',
              'A front desk must be a session in the same branch'
            );
          }
          if (session.archived) {
            throw new FrontDeskPinRefusedError(
              'session_archived',
              'An archived session cannot be a front desk'
            );
          }

          const occupant = await this.findOccupantIn(tx, { ...input, slot });
          if (
            input.expectedSessionId !== undefined &&
            (occupant?.session_id ?? null) !== input.expectedSessionId
          ) {
            throw new FrontDeskConflictError(
              'The front desk changed since it was read; re-read it and retry'
            );
          }
          if (occupant?.session_id === input.sessionId && occupant.status === 'active') {
            return { desk: occupant, unchanged: true };
          }

          const now = new Date();
          let replaced: BranchFrontDeskSession | undefined;
          if (occupant) {
            const won = await this.casStatus(tx, {
              id: occupant.id,
              expectedStatus: occupant.status,
              toStatus: 'retired',
              reason: 'replaced',
              at: now,
            });
            if (!won) {
              throw new FrontDeskConflictError('A concurrent change replaced the front desk first');
            }
            replaced = { ...occupant, status: 'retired', retired_reason: 'replaced' };
          }

          const values: BranchFrontDeskSessionInsert = {
            id: generateId(),
            branch_id: input.branchId,
            scope: input.scope,
            slot,
            session_id: input.sessionId,
            status: 'active',
            promoted_at: now,
            promoted_by: input.promotedBy ?? null,
            retired_at: null,
            retired_reason: null,
            metadata: null,
          };
          const row = await insert(tx, branchFrontDeskSessions).values(values).returning().one();
          return { desk: frontDeskFromRow(row), replaced, unchanged: false };
        },
        { sqliteImmediate: true }
      );
    } catch (error) {
      // Mapped outside the transaction: on PostgreSQL the violating statement
      // has already aborted it, and only the rolled-back unit is safe to leave.
      if (isDatabaseUniqueConstraintError(error)) {
        throw new FrontDeskConflictError(
          'A concurrent promotion claimed the front desk first',
          error
        );
      }
      throw error;
    }
  }

  /**
   * Conditionally move one row out of the slot. Returns whether this caller
   * won; `false` means another writer already changed it, which callers treat
   * as "someone else handled it", not as an error.
   */
  async demote(input: FrontDeskDemoteInput): Promise<boolean> {
    return this.casStatus(this.db, { ...input, at: new Date() });
  }

  /**
   * Retire the slot's occupant as `manual`. Returns the retired row, or `null`
   * when the slot was already empty. `expectedSessionId` guards against
   * clearing a pin someone else just replaced.
   */
  async clear(
    ref: FrontDeskSlotRef & { expectedSessionId?: SessionID }
  ): Promise<BranchFrontDeskSession | null> {
    const slot = ref.slot ?? FRONT_DESK_PRIMARY_SLOT;
    assertSupportedSlot(slot);
    const occupant = await this.findOccupant({ ...ref, slot });
    if (!occupant) return null;
    if (ref.expectedSessionId !== undefined && occupant.session_id !== ref.expectedSessionId) {
      throw new FrontDeskConflictError(
        'The front desk changed since it was read; re-read it and retry'
      );
    }
    const won = await this.demote({
      id: occupant.id,
      expectedStatus: occupant.status,
      toStatus: 'retired',
      reason: 'manual',
    });
    if (!won) throw new FrontDeskConflictError('A concurrent change moved the front desk first');
    return { ...occupant, status: 'retired', retired_reason: 'manual' };
  }

  private async findOccupantIn(
    db: Database,
    ref: FrontDeskSlotRef
  ): Promise<BranchFrontDeskSession | null> {
    const row = await select(db)
      .from(branchFrontDeskSessions)
      .where(
        and(
          eq(branchFrontDeskSessions.branch_id, ref.branchId),
          eq(branchFrontDeskSessions.scope, ref.scope),
          eq(branchFrontDeskSessions.slot, ref.slot ?? FRONT_DESK_PRIMARY_SLOT),
          inArray(branchFrontDeskSessions.status, [...FRONT_DESK_OCCUPYING_STATUSES])
        )
      )
      .one();
    return row ? frontDeskFromRow(row) : null;
  }

  private async casStatus(
    db: Database,
    input: FrontDeskDemoteInput & { at: Date }
  ): Promise<boolean> {
    const result = await update(db, branchFrontDeskSessions)
      .set({ status: input.toStatus, retired_at: input.at, retired_reason: input.reason })
      .where(
        and(
          eq(branchFrontDeskSessions.id, input.id),
          eq(branchFrontDeskSessions.status, input.expectedStatus)
        )
      )
      .run();
    return result.rowsAffected === 1;
  }
}
