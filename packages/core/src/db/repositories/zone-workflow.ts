import type {
  BoardEntityObject,
  BoardID,
  UUID,
  ZoneBoardObject,
  ZoneWorkflowAdvance,
  ZoneWorkflowAdvancedEntity,
  ZoneWorkflowEntityRef,
  ZoneWorkflowPromptOutcome,
  ZoneWorkflowTransition,
  ZoneWorkflowTransitionBehavior,
  ZoneWorkflowTransitionCreate,
  ZoneWorkflowTransitionPatch,
} from '@agor/core/types';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import {
  boardObjects,
  boards,
  branches,
  cards,
  type ZoneWorkflowAdvanceInsert,
  type ZoneWorkflowAdvanceRow,
  type ZoneWorkflowTransitionInsert,
  type ZoneWorkflowTransitionRow,
  zoneWorkflowAdvances,
  zoneWorkflowTransitions,
} from '../schema';
import { EntityNotFoundError, RepositoryError } from './base';

export interface ZoneWorkflowAdvanceResult {
  audit: ZoneWorkflowAdvance;
  moved: BoardEntityObject[];
  replayed: boolean;
}

function parseJson<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function isZone(value: unknown): value is ZoneBoardObject {
  return Boolean(
    value && typeof value === 'object' && (value as { type?: unknown }).type === 'zone'
  );
}

function normalizedReason(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function transitionFromRow(row: ZoneWorkflowTransitionRow): ZoneWorkflowTransition {
  return {
    transition_id: row.transition_id as UUID,
    board_id: row.board_id as BoardID,
    source_zone_id: row.source_zone_id,
    target_zone_id: row.target_zone_id,
    label: row.label,
    reason: row.reason ?? undefined,
    enabled: Boolean(row.enabled),
    behavior: row.behavior as ZoneWorkflowTransitionBehavior,
    created_by: row.created_by as UUID,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function advanceFromRow(row: ZoneWorkflowAdvanceRow, replayed = false): ZoneWorkflowAdvance {
  return {
    advance_id: row.advance_id as UUID,
    transition_id: row.transition_id as UUID,
    board_id: row.board_id as BoardID,
    idempotency_key: row.idempotency_key as UUID,
    source_zone_id: row.source_zone_id,
    target_zone_id: row.target_zone_id,
    transition_label: row.transition_label,
    transition_reason: row.transition_reason ?? undefined,
    behavior: row.behavior as ZoneWorkflowTransitionBehavior,
    entities: parseJson(row.entities),
    requested_by: row.requested_by as UUID,
    requested_at: new Date(row.requested_at).toISOString(),
    prompt_outcome: row.prompt_outcome as ZoneWorkflowPromptOutcome,
    prompt_error: row.prompt_error ?? undefined,
    ...(replayed ? { replayed: true } : {}),
  };
}

function boardObjectFromRow(row: typeof boardObjects.$inferSelect): BoardEntityObject {
  const data = parseJson<{ position: { x: number; y: number }; zone_id?: string }>(row.data);
  return {
    object_id: row.object_id,
    board_id: row.board_id as BoardID,
    branch_id: row.branch_id ? (row.branch_id as never) : undefined,
    card_id: row.card_id ? (row.card_id as never) : undefined,
    entity_type: row.card_id ? 'card' : 'branch',
    position: data.position,
    zone_id: data.zone_id,
    created_at: new Date(row.created_at).toISOString(),
  };
}

/** Repository owning transition uniqueness and atomic advance/idempotency. */
export class ZoneWorkflowRepository {
  constructor(private db: Database) {}

  async findTransitions(boardId?: BoardID): Promise<ZoneWorkflowTransition[]> {
    const query = select(this.db).from(zoneWorkflowTransitions);
    const rows = boardId
      ? await query
          .where(eq(zoneWorkflowTransitions.board_id, boardId))
          .orderBy(asc(zoneWorkflowTransitions.created_at))
          .all()
      : await query.orderBy(asc(zoneWorkflowTransitions.created_at)).all();
    return rows.map(transitionFromRow);
  }

  async findTransition(id: string): Promise<ZoneWorkflowTransition | null> {
    const row = await select(this.db)
      .from(zoneWorkflowTransitions)
      .where(eq(zoneWorkflowTransitions.transition_id, id))
      .one();
    return row ? transitionFromRow(row) : null;
  }

  async createTransition(
    data: ZoneWorkflowTransitionCreate,
    createdBy: UUID
  ): Promise<ZoneWorkflowTransition> {
    const duplicate = await select(this.db)
      .from(zoneWorkflowTransitions)
      .where(
        and(
          eq(zoneWorkflowTransitions.board_id, data.board_id),
          eq(zoneWorkflowTransitions.source_zone_id, data.source_zone_id),
          eq(zoneWorkflowTransitions.target_zone_id, data.target_zone_id)
        )
      )
      .one();
    if (duplicate) throw new RepositoryError('A transition already exists for this zone pair');

    const now = new Date();
    const row: ZoneWorkflowTransitionInsert = {
      transition_id: generateId(),
      board_id: data.board_id,
      source_zone_id: data.source_zone_id,
      target_zone_id: data.target_zone_id,
      label: data.label.trim(),
      reason: normalizedReason(data.reason),
      enabled: data.enabled ?? true,
      behavior: data.behavior ?? 'guidance_only',
      created_by: createdBy,
      created_at: now,
      updated_at: now,
    };
    try {
      await insert(this.db, zoneWorkflowTransitions).values(row).run();
    } catch (error) {
      // The unique index is the concurrent duplicate guard; do not expose DB details.
      throw new RepositoryError('A transition already exists for this zone pair', error);
    }
    return (await this.findTransition(row.transition_id))!;
  }

  async patchTransition(
    id: string,
    patch: ZoneWorkflowTransitionPatch
  ): Promise<ZoneWorkflowTransition> {
    const existing = await this.findTransition(id);
    if (!existing) throw new EntityNotFoundError('ZoneWorkflowTransition', id);
    const values: Partial<ZoneWorkflowTransitionInsert> = { updated_at: new Date() };
    if (patch.label !== undefined) values.label = patch.label.trim();
    if (patch.reason !== undefined) values.reason = normalizedReason(patch.reason);
    if (patch.enabled !== undefined) values.enabled = patch.enabled;
    if (patch.behavior !== undefined) values.behavior = patch.behavior;
    await update(this.db, zoneWorkflowTransitions)
      .set(values)
      .where(eq(zoneWorkflowTransitions.transition_id, existing.transition_id))
      .run();
    return (await this.findTransition(existing.transition_id))!;
  }

  async removeTransition(id: string): Promise<ZoneWorkflowTransition> {
    const existing = await this.findTransition(id);
    if (!existing) throw new EntityNotFoundError('ZoneWorkflowTransition', id);
    await deleteFrom(this.db, zoneWorkflowTransitions)
      .where(eq(zoneWorkflowTransitions.transition_id, existing.transition_id))
      .run();
    return existing;
  }

  async removeTransitionsForZone(
    boardId: BoardID,
    zoneId: string
  ): Promise<ZoneWorkflowTransition[]> {
    const rows = await select(this.db)
      .from(zoneWorkflowTransitions)
      .where(
        and(
          eq(zoneWorkflowTransitions.board_id, boardId),
          or(
            eq(zoneWorkflowTransitions.source_zone_id, zoneId),
            eq(zoneWorkflowTransitions.target_zone_id, zoneId)
          )
        )
      )
      .all();
    if (rows.length > 0) {
      await deleteFrom(this.db, zoneWorkflowTransitions)
        .where(
          and(
            eq(zoneWorkflowTransitions.board_id, boardId),
            or(
              eq(zoneWorkflowTransitions.source_zone_id, zoneId),
              eq(zoneWorkflowTransitions.target_zone_id, zoneId)
            )
          )
        )
        .run();
    }
    return rows.map(transitionFromRow);
  }

  async findAdvances(boardId?: BoardID): Promise<ZoneWorkflowAdvance[]> {
    const query = select(this.db).from(zoneWorkflowAdvances);
    const rows = boardId
      ? await query
          .where(eq(zoneWorkflowAdvances.board_id, boardId))
          .orderBy(asc(zoneWorkflowAdvances.requested_at))
          .all()
      : await query.orderBy(asc(zoneWorkflowAdvances.requested_at)).all();
    return rows.map((row: ZoneWorkflowAdvanceRow) => advanceFromRow(row));
  }

  async findAdvance(id: string): Promise<ZoneWorkflowAdvance | null> {
    const row = await select(this.db)
      .from(zoneWorkflowAdvances)
      .where(eq(zoneWorkflowAdvances.advance_id, id))
      .one();
    return row ? advanceFromRow(row) : null;
  }

  async advance(input: {
    transitionId: UUID;
    idempotencyKey: UUID;
    entities: ZoneWorkflowEntityRef[];
    requestedBy: UUID;
  }): Promise<ZoneWorkflowAdvanceResult> {
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockRowForUpdate(
          tx,
          this.db,
          zoneWorkflowTransitions,
          eq(zoneWorkflowTransitions.transition_id, input.transitionId)
        );
        const transitionRow = await select(tx)
          .from(zoneWorkflowTransitions)
          .where(eq(zoneWorkflowTransitions.transition_id, input.transitionId))
          .one();
        if (!transitionRow) {
          throw new EntityNotFoundError('ZoneWorkflowTransition', input.transitionId);
        }
        const transition = transitionFromRow(transitionRow);

        const prior = await select(tx)
          .from(zoneWorkflowAdvances)
          .where(eq(zoneWorkflowAdvances.idempotency_key, input.idempotencyKey))
          .one();
        if (prior) {
          const priorAudit = advanceFromRow(prior, true);
          if (priorAudit.transition_id !== input.transitionId) {
            throw new RepositoryError('Idempotency key was already used for another transition');
          }
          return { audit: priorAudit, moved: [], replayed: true };
        }

        if (!transition.enabled) throw new RepositoryError('Transition is disabled');
        const boardRow = await select(tx)
          .from(boards)
          .where(eq(boards.board_id, transition.board_id))
          .one();
        if (!boardRow || boardRow.archived)
          throw new RepositoryError('Board is archived or unavailable');
        const boardData = parseJson<{ objects?: Record<string, unknown> }>(boardRow.data);
        const sourceZone = boardData.objects?.[transition.source_zone_id];
        const targetZone = boardData.objects?.[transition.target_zone_id];
        if (!isZone(sourceZone) || !isZone(targetZone)) {
          throw new RepositoryError('Transition source and target zones must still exist');
        }

        const refs = new Map(
          input.entities.map((entity) => [`${entity.entity_type}:${entity.entity_id}`, entity])
        );
        if (refs.size !== input.entities.length)
          throw new RepositoryError('Duplicate entities are not allowed');

        const rows = await select(tx)
          .from(boardObjects)
          .where(eq(boardObjects.board_id, transition.board_id))
          .all();
        const byRef = new Map<string, (typeof rows)[number]>();
        for (const row of rows) {
          if (row.branch_id) byRef.set(`branch:${row.branch_id}`, row);
          if (row.card_id) byRef.set(`card:${row.card_id}`, row);
        }

        const branchIds = input.entities
          .filter(
            (entity): entity is Extract<ZoneWorkflowEntityRef, { entity_type: 'branch' }> =>
              entity.entity_type === 'branch'
          )
          .map((entity) => entity.entity_id);
        const cardIds = input.entities
          .filter(
            (entity): entity is Extract<ZoneWorkflowEntityRef, { entity_type: 'card' }> =>
              entity.entity_type === 'card'
          )
          .map((entity) => entity.entity_id);
        const activeBranches = new Set(
          branchIds.length
            ? (
                await select(tx, { id: branches.branch_id })
                  .from(branches)
                  .where(and(inArray(branches.branch_id, branchIds), eq(branches.archived, false)))
                  .all()
              ).map((row: { id: string }) => row.id)
            : []
        );
        const activeCards = new Set(
          cardIds.length
            ? (
                await select(tx, { id: cards.card_id })
                  .from(cards)
                  .where(and(inArray(cards.card_id, cardIds), eq(cards.archived, false)))
                  .all()
              ).map((row: { id: string }) => row.id)
            : []
        );

        const moved: BoardEntityObject[] = [];
        const auditedEntities: ZoneWorkflowAdvancedEntity[] = [];
        for (const entity of input.entities) {
          const key = `${entity.entity_type}:${entity.entity_id}`;
          const row = byRef.get(key);
          if (!row)
            throw new RepositoryError('Every entity must be positioned on the transition board');
          const active =
            entity.entity_type === 'branch'
              ? activeBranches.has(entity.entity_id)
              : activeCards.has(entity.entity_id);
          if (!active) throw new RepositoryError('Archived entities cannot be advanced');
          const data = parseJson<{ position: { x: number; y: number }; zone_id?: string }>(
            row.data
          );
          if (data.zone_id !== transition.source_zone_id) {
            throw new RepositoryError(
              'Every entity must currently be in the transition source zone'
            );
          }

          const position = {
            x: Math.max(20, Math.min(data.position.x, Math.max(20, targetZone.width - 80))),
            y: Math.max(40, Math.min(data.position.y, Math.max(40, targetZone.height - 60))),
          };
          await update(tx, boardObjects)
            .set({ data: { position, zone_id: transition.target_zone_id } })
            .where(eq(boardObjects.object_id, row.object_id))
            .run();
          const updated = { ...row, data: { position, zone_id: transition.target_zone_id } };
          moved.push(boardObjectFromRow(updated));
          auditedEntities.push({
            ...entity,
            board_object_id: row.object_id as UUID,
          });
        }

        const auditInsert: ZoneWorkflowAdvanceInsert = {
          advance_id: generateId(),
          transition_id: transition.transition_id,
          board_id: transition.board_id,
          idempotency_key: input.idempotencyKey,
          source_zone_id: transition.source_zone_id,
          target_zone_id: transition.target_zone_id,
          transition_label: transition.label,
          transition_reason: transition.reason ?? null,
          behavior: transition.behavior,
          entities: auditedEntities,
          requested_by: input.requestedBy,
          requested_at: new Date(),
          prompt_outcome:
            transition.behavior === 'guidance_only' ? 'not_requested' : 'not_applicable',
          prompt_error: null,
        };
        await insert(tx, zoneWorkflowAdvances).values(auditInsert).run();
        const auditRow = await select(tx)
          .from(zoneWorkflowAdvances)
          .where(eq(zoneWorkflowAdvances.advance_id, auditInsert.advance_id))
          .one();
        if (!auditRow) throw new RepositoryError('Failed to persist workflow advance audit');
        return { audit: advanceFromRow(auditRow), moved, replayed: false };
      },
      { sqliteImmediate: true, postgresIsolationLevel: 'serializable' }
    );
  }

  async setPromptOutcome(
    advanceId: UUID,
    outcome: ZoneWorkflowPromptOutcome,
    error?: string
  ): Promise<ZoneWorkflowAdvance> {
    await update(this.db, zoneWorkflowAdvances)
      .set({ prompt_outcome: outcome, prompt_error: error?.slice(0, 500) ?? null })
      .where(eq(zoneWorkflowAdvances.advance_id, advanceId))
      .run();
    const row = await this.findAdvance(advanceId);
    if (!row) throw new EntityNotFoundError('ZoneWorkflowAdvance', advanceId);
    return row;
  }
}
