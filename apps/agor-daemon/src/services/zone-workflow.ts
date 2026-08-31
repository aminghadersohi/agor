import {
  BoardRepository,
  BranchRepository,
  type TenantScopeAwareDatabase,
  type ZoneWorkflowAdvanceResult,
  ZoneWorkflowRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest, Conflict, NotFound } from '@agor/core/feathers';
import { isValidUUID } from '@agor/core/ids';
import type {
  AuthenticatedParams,
  BoardID,
  QueryParams,
  UUID,
  ZoneBoardObject,
  ZoneWorkflowAdvance,
  ZoneWorkflowAdvanceRequest,
  ZoneWorkflowTransition,
  ZoneWorkflowTransitionBehavior,
  ZoneWorkflowTransitionCreate,
  ZoneWorkflowTransitionPatch,
} from '@agor/core/types';
import { emitServiceEvent } from '../utils/emit-service-event.js';
import { fireAlwaysNewZoneTrigger } from './zone-trigger.js';

const TRANSITION_BEHAVIORS = new Set<ZoneWorkflowTransitionBehavior>([
  'guidance_only',
  'target_zone_prompt',
]);
const MAX_ADVANCE_ENTITIES = 100;

export type ZoneWorkflowParams = QueryParams<{ board_id?: BoardID }> & AuthenticatedParams;

function requiredTrimmed(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequest(`${field} is required`);
  const result = value.trim();
  if (result.length > max) throw new BadRequest(`${field} must be at most ${max} characters`);
  return result;
}

function optionalTrimmed(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequest(`${field} must be a string`);
  const result = value.trim();
  if (result.length > max) throw new BadRequest(`${field} must be at most ${max} characters`);
  return result || undefined;
}

function assertBehavior(value: unknown): asserts value is ZoneWorkflowTransitionBehavior {
  if (typeof value !== 'string' || !TRANSITION_BEHAVIORS.has(value as never)) {
    throw new BadRequest('behavior must be guidance_only or target_zone_prompt');
  }
}

function normalizeRepositoryError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/already exists|Idempotency key was already used/i.test(message)) throw new Conflict(message);
  if (/not found|unavailable/i.test(message)) throw new NotFound(message);
  throw new BadRequest(message);
}

export class ZoneWorkflowTransitionsService {
  private repo: ZoneWorkflowRepository;
  private boards: BoardRepository;

  constructor(db: TenantScopeAwareDatabase) {
    this.repo = new ZoneWorkflowRepository(db);
    this.boards = new BoardRepository(db);
  }

  async find(params?: ZoneWorkflowParams) {
    const boardId = params?.query?.board_id;
    const data = await this.repo.findTransitions(boardId);
    return { total: data.length, limit: data.length, skip: 0, data };
  }

  async get(id: string): Promise<ZoneWorkflowTransition> {
    const transition = await this.repo.findTransition(id);
    if (!transition) throw new NotFound('Workflow transition not found');
    return transition;
  }

  async create(
    raw: ZoneWorkflowTransitionCreate,
    params?: ZoneWorkflowParams
  ): Promise<ZoneWorkflowTransition> {
    if (!params?.user?.user_id) throw new BadRequest('Authenticated user is required');
    if (!isValidUUID(raw.board_id)) throw new BadRequest('board_id must be a canonical UUID');
    const sourceZoneId = requiredTrimmed(raw.source_zone_id, 'source_zone_id', 200);
    const targetZoneId = requiredTrimmed(raw.target_zone_id, 'target_zone_id', 200);
    if (sourceZoneId === targetZoneId)
      throw new BadRequest('Self-linked transitions are not allowed');
    const board = await this.boards.findById(raw.board_id);
    if (!board || board.archived) throw new NotFound('Board is archived or unavailable');
    if (board.objects?.[sourceZoneId]?.type !== 'zone') {
      throw new BadRequest('source_zone_id must name a zone on this board');
    }
    if (board.objects?.[targetZoneId]?.type !== 'zone') {
      throw new BadRequest('target_zone_id must name a zone on this board');
    }
    const behavior = raw.behavior ?? 'guidance_only';
    assertBehavior(behavior);
    try {
      return await this.repo.createTransition(
        {
          board_id: raw.board_id,
          source_zone_id: sourceZoneId,
          target_zone_id: targetZoneId,
          label: requiredTrimmed(raw.label, 'label', 120),
          reason: optionalTrimmed(raw.reason, 'reason', 1000),
          enabled: raw.enabled ?? true,
          behavior,
        },
        params.user.user_id as UUID
      );
    } catch (error) {
      normalizeRepositoryError(error);
    }
  }

  async patch(
    id: string,
    raw: ZoneWorkflowTransitionPatch,
    _params?: ZoneWorkflowParams
  ): Promise<ZoneWorkflowTransition> {
    const allowed = new Set(['label', 'reason', 'enabled', 'behavior']);
    if (Object.keys(raw).some((key) => !allowed.has(key))) {
      throw new BadRequest('Only label, reason, enabled, and behavior can be updated');
    }
    const patch: ZoneWorkflowTransitionPatch = {};
    if (raw.label !== undefined) patch.label = requiredTrimmed(raw.label, 'label', 120);
    if (raw.reason !== undefined)
      patch.reason = optionalTrimmed(raw.reason, 'reason', 1000) ?? null;
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled !== 'boolean') throw new BadRequest('enabled must be boolean');
      patch.enabled = raw.enabled;
    }
    if (raw.behavior !== undefined) {
      assertBehavior(raw.behavior);
      patch.behavior = raw.behavior;
    }
    try {
      return await this.repo.patchTransition(id, patch);
    } catch (error) {
      normalizeRepositoryError(error);
    }
  }

  async remove(id: string): Promise<ZoneWorkflowTransition> {
    try {
      return await this.repo.removeTransition(id);
    } catch (error) {
      normalizeRepositoryError(error);
    }
  }
}

export class ZoneWorkflowAdvancesService {
  private repo: ZoneWorkflowRepository;
  private boards: BoardRepository;
  private branches: BranchRepository;

  constructor(
    db: TenantScopeAwareDatabase,
    private app: Application
  ) {
    this.repo = new ZoneWorkflowRepository(db);
    this.boards = new BoardRepository(db);
    this.branches = new BranchRepository(db);
  }

  async find(params?: ZoneWorkflowParams) {
    const data = await this.repo.findAdvances(params?.query?.board_id);
    return { total: data.length, limit: data.length, skip: 0, data };
  }

  async get(id: string): Promise<ZoneWorkflowAdvance> {
    const advance = await this.repo.findAdvance(id);
    if (!advance) throw new NotFound('Workflow advance audit not found');
    return advance;
  }

  async create(
    raw: ZoneWorkflowAdvanceRequest,
    params?: ZoneWorkflowParams
  ): Promise<ZoneWorkflowAdvance> {
    const user = params?.user;
    if (!user?.user_id) throw new BadRequest('Authenticated user is required');
    if (!isValidUUID(raw.transition_id)) throw new BadRequest('transition_id must be a UUID');
    if (!isValidUUID(raw.idempotency_key)) throw new BadRequest('idempotency_key must be a UUID');
    if (!Array.isArray(raw.entities) || raw.entities.length === 0) {
      throw new BadRequest('entities must contain at least one branch or card');
    }
    if (raw.entities.length > MAX_ADVANCE_ENTITIES) {
      throw new BadRequest(`entities must contain at most ${MAX_ADVANCE_ENTITIES} items`);
    }
    for (const entity of raw.entities) {
      if (
        !entity ||
        (entity.entity_type !== 'branch' && entity.entity_type !== 'card') ||
        !isValidUUID(entity.entity_id)
      ) {
        throw new BadRequest('Every entity must have a valid entity_type and UUID entity_id');
      }
    }

    let result: ZoneWorkflowAdvanceResult;
    try {
      result = await this.repo.advance({
        transitionId: raw.transition_id,
        idempotencyKey: raw.idempotency_key,
        entities: raw.entities,
        requestedBy: user.user_id as UUID,
      });
    } catch (error) {
      normalizeRepositoryError(error);
    }

    if (result.replayed) return result.audit;

    for (const boardObject of result.moved) {
      emitServiceEvent(this.app, {
        path: 'board-objects',
        event: 'patched',
        data: boardObject,
        params,
        id: boardObject.object_id,
      });
    }

    if (result.audit.behavior !== 'target_zone_prompt') return result.audit;
    const branchEntities = result.audit.entities.filter(
      (entity) => entity.entity_type === 'branch'
    );
    if (branchEntities.length === 0) {
      return this.repo.setPromptOutcome(result.audit.advance_id, 'not_applicable');
    }

    const board = await this.boards.findById(result.audit.board_id);
    const zone = board?.objects?.[result.audit.target_zone_id] as ZoneBoardObject | undefined;
    if (!zone?.trigger?.template?.trim()) {
      return this.repo.setPromptOutcome(result.audit.advance_id, 'target_has_no_trigger');
    }
    if (zone.trigger.behavior !== 'always_new') {
      // Picker triggers require an explicit session/action choice. An advance is
      // deliberately non-interactive, so never reinterpret it as an authorized prompt.
      return this.repo.setPromptOutcome(result.audit.advance_id, 'target_requires_picker');
    }

    try {
      const fullUser = await this.app.service('users').get(user.user_id, params);
      for (const entity of branchEntities) {
        const branch = await this.branches.findById(entity.entity_id);
        if (!branch) throw new Error('Advanced branch is no longer available');
        await fireAlwaysNewZoneTrigger({
          app: this.app,
          params,
          branch,
          board: board ?? {},
          zone,
          user: fullUser,
          userId: user.user_id,
        });
      }
      return this.repo.setPromptOutcome(result.audit.advance_id, 'triggered');
    } catch (error) {
      return this.repo.setPromptOutcome(
        result.audit.advance_id,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

export function createZoneWorkflowTransitionsService(db: TenantScopeAwareDatabase) {
  return new ZoneWorkflowTransitionsService(db);
}

export function createZoneWorkflowAdvancesService(db: TenantScopeAwareDatabase, app: Application) {
  return new ZoneWorkflowAdvancesService(db, app);
}
