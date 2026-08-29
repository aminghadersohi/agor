import { layoutJustifiedZones, zoneShapesForItems } from '@agor/core/layout/justified-zones';
import { layoutRectangles } from '@agor/core/layout/rectangle-packing';
import {
  normalizeZoneLayoutPolicy,
  sortZoneLayoutItems,
  ZONE_LAYOUT_MODES,
  ZONE_LAYOUT_PRESETS,
  ZONE_LAYOUT_SORT_DIRECTIONS,
  ZONE_LAYOUT_SORT_FIELDS,
  type ZoneLayoutSortItem,
} from '@agor/core/layout/zone-layout';
import type {
  Board,
  BoardEntityObject,
  BoardEntityType,
  BoardObject,
  BoardObjectType,
  Branch,
  BranchID,
  Card,
  ZoneLayoutPolicy,
} from '@agor/core/types';
import { BRANCH_PERMISSION_LEVELS } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { BoardsServiceImpl } from '../../declarations.js';
import { emitServiceEvent } from '../../utils/emit-service-event.js';
import { boardCapabilityPoliciesSchema } from '../capability-policy-schema.js';
import {
  mcpListLimit,
  mcpOffset,
  mcpOptionalNonNegativeInt,
  mcpOptionalNumber,
  mcpOptionalPositiveInt,
  mcpOptionalString,
  mcpPageResult,
  mcpRequiredId,
  mcpRequiredString,
} from '../schema.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope, runWithMcpTenantDatabaseWrite } from '../tenant-scope.js';

const BOARD_OBJECT_TYPES = [
  'zone',
  'text',
  'markdown',
  'app',
  'artifact',
] as const satisfies readonly BoardObjectType[];
const BOARD_ENTITY_TYPES = ['branch', 'card'] as const satisfies readonly BoardEntityType[];

// These match the rendered React Flow nodes.  Keeping the dimensions here is
// important: a zone arrange must never blindly use the branch-card spacing for
// every entity or it can place the last row below the zone.
const ARRANGE_DIMENSIONS = {
  branch: { width: 500, height: 200 },
  // A card with only a title is roughly one header row. Content adds height
  // below; using 150px as the minimum made normal cards look artificially
  // oversized and caused unnecessary deck layouts.
  card: { width: 380, height: 56 },
} as const;
const DECK_OFFSET_X = 12;
const DECK_OFFSET_Y = 48;
const DEFAULT_ARRANGE_START_X = 80;
const DEFAULT_ARRANGE_START_Y = 80;
const COMPACT_ARRANGE_DIMENSIONS = {
  branch: { width: 500, height: 88 },
  card: { width: 380, height: 56 },
} as const;

function zoneContentTopInset(zone: { fontSize?: number; status?: string }): number {
  const labelFontSize =
    typeof zone.fontSize === 'number' && Number.isFinite(zone.fontSize)
      ? Math.min(48, Math.max(10, zone.fontSize))
      : 14;
  const labelHeight = Math.ceil(labelFontSize * 1.2);
  const statusHeight = zone.status ? 8 + Math.ceil(labelFontSize * 1.05) : 0;

  return Math.max(64, 32 + labelHeight + statusHeight);
}

function compareBoardEntitiesSpatially(a: BoardEntityObject, b: BoardEntityObject): number {
  return (
    a.position.y - b.position.y ||
    a.position.x - b.position.x ||
    a.object_id.localeCompare(b.object_id)
  );
}

type EntityLayoutMetadata = ZoneLayoutSortItem & {
  card?: Card;
  branch?: Branch;
};

async function loadEntityLayoutMetadata(
  ctx: McpContext,
  entities: readonly BoardEntityObject[]
): Promise<Map<string, EntityLayoutMetadata>> {
  const metadata = new Map<string, EntityLayoutMetadata>();
  await Promise.all(
    entities.map(async (entity) => {
      let card: Card | undefined;
      let branch: Branch | undefined;
      if (entity.card_id) {
        card = (await ctx.app.service('cards').get(entity.card_id, ctx.baseServiceParams)) as Card;
      } else if (entity.branch_id) {
        branch = (await ctx.app
          .service('branches')
          .get(entity.branch_id, ctx.baseServiceParams)) as Branch;
      }
      const cardData = card?.data ?? {};
      metadata.set(entity.object_id, {
        id: entity.object_id,
        position: entity.position,
        title: card?.title ?? branch?.name,
        createdAt: card?.created_at ?? branch?.created_at ?? entity.created_at,
        updatedAt: card?.updated_at ?? branch?.updated_at ?? entity.created_at,
        rank: typeof cardData.rank === 'number' ? cardData.rank : undefined,
        priority: cardData.priority,
        status: cardData.status ?? branch?.filesystem_status,
        card,
        branch,
      });
    })
  );
  return metadata;
}

/**
 * CardNode grows with its description and (unlike the React Flow placeholder
 * height) renders the note in full. Estimate the rendered rectangle from the
 * persisted content before laying out. This is deliberately conservative: a
 * false overflow warning is preferable to putting the bottom of a card
 * outside its zone.
 */
function estimateCardHeight(
  card: { title?: string; description?: string; note?: string } | undefined
): number {
  const lineCount = (value: string | undefined, charsPerLine: number) =>
    value ? Math.max(1, Math.ceil(value.length / charsPerLine)) : 0;
  const header = 50;
  const description = card?.description
    ? 16 +
      lineCount(card.description.slice(0, 100), 48) * 18 +
      (card.description.length > 100 ? 18 : 0)
    : 0;
  const note = card?.note ? 16 + lineCount(card.note, 48) * 18 : 0;
  return Math.max(ARRANGE_DIMENSIONS.card.height, header + description + note);
}

/**
 * A persisted `size` the solver can actually lay out, or undefined.
 *
 * `size` is written by the browser once a node has been measured, so an entity
 * created over MCP legitimately has none and falls back to the nominal size for
 * its kind. A size that is present but zero, negative, or non-finite is a
 * different thing: `layoutRectangles` refuses it, and refusing it there would
 * fail the whole arrange over one bad rectangle. Discard it and fall back to
 * nominal too, reporting the id so the anomaly is visible rather than silent.
 */
function measuredSize(
  entity: Pick<BoardEntityObject, 'size'>
): { width: number; height: number } | undefined {
  const size = entity.size;
  if (!size) return undefined;
  const usable =
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0;
  return usable ? size : undefined;
}

function hasUnusableSize(entity: Pick<BoardEntityObject, 'size'>): boolean {
  return entity.size !== undefined && measuredSize(entity) === undefined;
}

type CanvasRectangle = { id: string; x: number; y: number; width: number; height: number };

function rectanglesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Zone rectangles a whole-board arrange must not lay its grid on top of.
 *
 * A zone is a container, not an annotation: dropping free-floating entities
 * into its rectangle reads as "these belong to this zone" even though the
 * arrange never pinned them. Zones that the same call is arranging are
 * excluded — they are layout items, so they move out of their own way.
 */
function zoneObstacles(board: Board, arrangingZones: boolean): CanvasRectangle[] {
  if (arrangingZones) return [];
  return Object.entries(board.objects ?? {}).flatMap(([objectId, object]) => {
    if (object.type !== 'zone') return [];
    const { x, y, width, height } = object;
    return [{ id: objectId, x, y, width, height }];
  });
}

/**
 * Zones that the given rectangle would sit on top of.
 *
 * Growing a zone to fit its contents is not free: a zone is a rectangle on a
 * shared canvas, and autoResizeHeight moves its bottom edge without asking what
 * is underneath it. A zone that silently swallows its neighbour is the same
 * class of defect this tool refuses to create *inside* a zone, so it is
 * reported rather than performed in silence. The resize still happens —
 * contents overflowing their own zone is the worse outcome — but the caller is
 * told which zones it now covers, and agor_boards_auto_arrange with
 * includeZones:true is the repair.
 */
function zonesOverlappedBy(
  board: Board,
  zoneId: string,
  rect: { x: number; y: number; width: number; height: number }
): string[] {
  return Object.entries(board.objects ?? {}).flatMap(([objectId, object]) => {
    if (objectId === zoneId || object.type !== 'zone') return [];
    const { x, y, width, height } = object;
    return rectanglesOverlap(rect, { x, y, width, height }) ? [objectId] : [];
  });
}

/**
 * Pick the grid origin for a whole-board arrange.
 *
 * An explicit `startY` is always honored — the caller asked for that row. A
 * defaulted one drops past each zone it lands on until the grid is clear,
 * which settles on the first free row rather than below the lowest zone on the
 * board: a single zone parked far down the canvas should not exile the grid
 * with it. Each pass clears every zone that was blocking, so no zone can block
 * twice and the loop terminates in at most one pass per zone.
 */
function resolveArrangeOrigin(options: {
  startX: number;
  startY: number;
  explicitStartY: boolean;
  layout: { width: number; height: number };
  gapY: number;
  obstacles: readonly CanvasRectangle[];
}): { startX: number; startY: number; avoidedZoneIds: string[] } {
  const { startX, startY, explicitStartY, layout, gapY, obstacles } = options;
  if (explicitStartY || obstacles.length === 0 || layout.width <= 0 || layout.height <= 0) {
    return { startX, startY, avoidedZoneIds: [] };
  }
  const avoidedZoneIds: string[] = [];
  let y = startY;
  for (let pass = 0; pass <= obstacles.length; pass += 1) {
    const grid = { x: startX, y, width: layout.width, height: layout.height };
    const blocking = obstacles.filter((zone) => rectanglesOverlap(grid, zone));
    if (blocking.length === 0) break;
    avoidedZoneIds.push(...blocking.map((zone) => zone.id));
    y = Math.max(...blocking.map((zone) => zone.y + zone.height)) + gapY;
  }
  return { startX, startY: y, avoidedZoneIds };
}

function getCanvasObjectDimensions(object: BoardObject): { width: number; height: number } {
  if (object.type === 'text') {
    return { width: object.width ?? 240, height: object.height ?? 120 };
  }
  if (object.type === 'markdown') {
    const charsPerLine = Math.max(20, Math.floor(object.width / 8));
    const lines = Math.max(3, Math.ceil(object.content.length / charsPerLine));
    return { width: object.width, height: Math.max(140, 48 + lines * 20) };
  }
  if (object.type === 'app' || object.type === 'artifact' || object.type === 'zone') {
    return { width: object.width, height: object.height };
  }
  return { width: 240, height: 120 };
}

async function filterVisibleBoardEntities(
  ctx: McpContext,
  entities: BoardEntityObject[],
  includeArchived: boolean
): Promise<BoardEntityObject[]> {
  if (includeArchived) return entities;
  const activeCardIds = new Set<string>();
  const cardIds = entities.flatMap((entity) => (entity.card_id ? [entity.card_id] : []));
  if (cardIds.length > 0) {
    const result = await ctx.app.service('cards').find({
      query: { card_id: { $in: Array.from(new Set(cardIds)) }, archived: false },
      paginate: false,
      ...ctx.baseServiceParams,
    });
    const cards = Array.isArray(result)
      ? result
      : (result as { data: Array<{ card_id: string }> }).data;
    for (const card of cards) activeCardIds.add(card.card_id);
  }
  const activeBranchIds = new Set<string>();
  const branchIds = entities.flatMap((entity) => (entity.branch_id ? [entity.branch_id] : []));
  if (branchIds.length > 0) {
    const result = await ctx.app.service('branches').find({
      query: { branch_id: { $in: Array.from(new Set(branchIds)) }, archived: false },
      paginate: false,
      ...ctx.baseServiceParams,
    });
    const branches = Array.isArray(result)
      ? result
      : (result as { data: Array<{ branch_id: string }> }).data;
    for (const branch of branches) activeBranchIds.add(branch.branch_id);
  }
  return entities.filter(
    (entity) =>
      (entity.card_id === undefined || activeCardIds.has(entity.card_id)) &&
      (entity.branch_id === undefined || activeBranchIds.has(entity.branch_id))
  );
}

function filterBoardCanvasObjects(board: Board, objectTypes?: BoardObjectType[]): Board {
  if (!objectTypes) return board;

  const allowedTypes = new Set<BoardObjectType>(objectTypes);
  const objects = Object.fromEntries(
    Object.entries(board.objects ?? {}).filter(([, object]) =>
      allowedTypes.has((object as BoardObject).type)
    )
  );

  return { ...board, objects };
}

export function registerBoardTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_boards_get
  server.registerTool(
    'agor_boards_get',
    {
      description:
        'Get information about a board, including zones, canvas objects, and optionally positioned entities (branches, cards). ' +
        'The response includes a `url` field with a clickable link to view the board in the UI. ' +
        'By default, returns board metadata and canvas objects only (no positioned branch/card entities). ' +
        'Use objectTypes=["zone"] for a lean board definition with just zones. ' +
        'Set includeEntities=true to include positioned branch/card entities, optionally filtered by entityZoneId/entityType and paginated with entitiesLimit/entitiesSkip.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        objectTypes: z
          .array(z.enum(BOARD_OBJECT_TYPES))
          .optional()
          .describe(
            'Filter board.objects canvas annotations by type. Use ["zone"] to retrieve zone definitions without heavier text/markdown/app/artifact objects. Omit for backward-compatible behavior returning all board.objects.'
          ),
        includeEntities: z
          .boolean()
          .optional()
          .describe(
            'Include positioned entities (branches, cards) with their x/y coordinates and zone assignments (default: false). Enable when you need to know where branches are placed on the canvas.'
          ),
        includeArchived: z
          .boolean()
          .optional()
          .describe(
            'When includeEntities=true, include archived branch entities. Default false excludes archived branches while preserving card entities.'
          ),
        entityZoneId: mcpOptionalString(
          'entityZoneId',
          'When includeEntities=true, only return positioned entities pinned to this board zone ID.'
        ),
        entityType: z
          .enum(BOARD_ENTITY_TYPES)
          .optional()
          .describe(
            'When includeEntities=true, only return positioned entities of this type ("branch" or "card").'
          ),
        entitiesLimit: mcpOptionalPositiveInt(
          'entitiesLimit',
          'When includeEntities=true, maximum number of positioned entities to return. Omit to preserve legacy behavior returning all matched entities.'
        )
          .refine(
            (value) => value === undefined || value <= 10000,
            'entitiesLimit must be less than or equal to 10000.'
          )
          .describe(
            'When includeEntities=true, maximum number of positioned entities to return. Omit to preserve legacy behavior returning all matched entities.'
          ),
        entitiesSkip: mcpOptionalNonNegativeInt(
          'entitiesSkip',
          'When includeEntities=true, number of matched positioned entities to skip for pagination (default: 0).'
        )
          .refine(
            (value) => value === undefined || value <= 10000,
            'entitiesSkip must be less than or equal to 10000.'
          )
          .describe(
            'When includeEntities=true, number of matched positioned entities to skip for pagination (default: 0).'
          ),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      if (!boardId) throw new Error('boardId is required');
      const board = filterBoardCanvasObjects(
        await ctx.app.service('boards').get(boardId, ctx.baseServiceParams),
        args.objectTypes as BoardObjectType[] | undefined
      );
      const permissions = await ctx.app
        .service('boards/:id/permissions')
        .find({ ...ctx.baseServiceParams, route: { id: board.board_id } });

      const includeEntities = args.includeEntities === true; // default false, opt-in
      if (includeEntities) {
        const entityQuery: Record<string, unknown> = { board_id: board.board_id };
        const entityZoneId = coerceString(args.entityZoneId);
        if (entityZoneId) entityQuery.zone_id = entityZoneId;
        if (args.entityType) entityQuery.entity_type = args.entityType as BoardEntityType;

        const boardObjectsResult = await ctx.app
          .service('board-objects')
          .find({ query: entityQuery, ...ctx.baseServiceParams });
        const matchedEntities = (
          boardObjectsResult as { data: import('@agor/core/types').BoardEntityObject[] }
        ).data;
        let visibleEntities = matchedEntities;

        if (args.includeArchived !== true) {
          const branchIds = matchedEntities
            .map((entity) => entity.branch_id)
            .filter((branchId): branchId is BranchID => typeof branchId === 'string');

          if (branchIds.length > 0) {
            const activeBranchesResult = await ctx.app.service('branches').find({
              query: {
                branch_id: { $in: Array.from(new Set(branchIds)) },
                archived: false,
              },
              paginate: false,
              ...ctx.baseServiceParams,
            });
            const activeBranches = Array.isArray(activeBranchesResult)
              ? activeBranchesResult
              : (activeBranchesResult as { data: Array<{ branch_id: string }> }).data;
            const activeBranchIds = new Set(activeBranches.map((branch) => branch.branch_id));

            visibleEntities = matchedEntities.filter(
              (entity) => !entity.branch_id || activeBranchIds.has(entity.branch_id)
            );
          }
        }

        const total = visibleEntities.length;
        const skip = args.entitiesSkip ?? 0;
        const limit = args.entitiesLimit ?? null;
        const entities =
          args.entitiesLimit !== undefined || args.entitiesSkip !== undefined
            ? visibleEntities.slice(
                skip,
                args.entitiesLimit === undefined ? undefined : skip + args.entitiesLimit
              )
            : visibleEntities;

        return textResult({
          ...board,
          permissions,
          entities,
          entities_pagination: { total, limit, skip },
        });
      }

      return textResult({ ...board, permissions });
    }
  );

  // Tool 2: agor_boards_list
  server.registerTool(
    'agor_boards_list',
    {
      description:
        'List a lean page of boards accessible to the current user (heavy canvas objects and custom CSS are omitted; use agor_boards_get for details). By default archived boards are excluded. Advance with offset=nextOffset while hasMore is true.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        limit: mcpListLimit(),
        offset: mcpOffset(),
        includeArchived: z
          .boolean()
          .optional()
          .describe(
            'Include archived boards in results (default: false). By default, archived boards are excluded.'
          ),
        archived: z
          .boolean()
          .optional()
          .describe(
            'Filter to show ONLY archived boards. When true, returns only archived boards. Overrides includeArchived.'
          ),
      }),
    },
    async (args) => {
      const limit = args.limit ?? 25;
      const offset = args.offset ?? 0;
      const query: Record<string, unknown> = {
        $limit: limit,
        $skip: offset,
        lean: true,
        $sort: { created_at: -1, board_id: 1 },
      };
      if (args.archived === true) {
        query.archived = true;
      } else if (!args.includeArchived) {
        query.archived = false;
      }
      const boards = await ctx.app.service('boards').find({ query, ...ctx.baseServiceParams });
      return textResult(mcpPageResult(boards, limit, offset));
    }
  );

  // Tool 3: agor_boards_update
  server.registerTool(
    'agor_boards_update',
    {
      description:
        'Update board metadata and manage zones/objects. Can update name, icon, background, and create/update zones for organizing branches. Unicode emoji is preferred for icons; common exact shortcodes like ":compass:" are accepted and normalized. Zone objects have: type="zone", x, y, width, height, label, borderColor, backgroundColor, borderStyle (optional), trigger (optional: "always_new" auto-creates sessions, "show_picker" shows agent selection). Text objects have: type="text", x, y, text, fontSize, color. Markdown objects have: type="markdown", x, y, width, height, content.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        name: mcpOptionalString('name', 'Board name (optional)'),
        description: mcpOptionalString('description', 'Board description (optional)'),
        icon: mcpOptionalString(
          'icon',
          'Board icon/emoji (optional). Unicode emoji is preferred; common exact shortcodes like ":compass:" are accepted and normalized.'
        ),
        color: mcpOptionalString('color', 'Board color (hex format, optional)'),
        backgroundColor: mcpOptionalString(
          'backgroundColor',
          'Board background color (hex format, optional)'
        ),
        customCss: mcpOptionalString(
          'customCss',
          'Custom CSS for board canvas animations (@keyframes, animation, background-size, etc.). Rendered in a scoped <style> tag. Dangerous patterns like url(), expression(), @import are blocked.'
        ),
        slug: mcpOptionalString('slug', 'URL-friendly slug (optional)'),
        customContext: z
          .object({})
          .passthrough()
          .optional()
          .describe('Custom context for templates (optional)'),
        upsertObjects: z
          .object({})
          .passthrough()
          .optional()
          .describe(
            'Board objects to upsert (zones, text, markdown). Keys are object IDs, values are object data.'
          ),
        removeObjects: z
          .array(mcpRequiredString('removeObjects[]', 'Board object ID to remove'))
          .optional()
          .describe('Array of object IDs to remove from the board'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      if (!boardId) throw new Error('boardId is required');
      const boardsService = ctx.app.service('boards') as unknown as BoardsServiceImpl;

      const metadataUpdates: Record<string, unknown> = {};
      if (args.name !== undefined) metadataUpdates.name = args.name;
      if (args.description !== undefined) metadataUpdates.description = args.description;
      if (args.icon !== undefined) metadataUpdates.icon = args.icon;
      if (args.color !== undefined) metadataUpdates.color = args.color;
      if (args.backgroundColor !== undefined)
        metadataUpdates.background_color = args.backgroundColor;
      if (args.customCss !== undefined) metadataUpdates.custom_css = args.customCss;
      if (args.slug !== undefined) metadataUpdates.slug = args.slug;
      if (args.customContext !== undefined) metadataUpdates.custom_context = args.customContext;

      if (Object.keys(metadataUpdates).length > 0) {
        await ctx.app.service('boards').patch(boardId, metadataUpdates, ctx.baseServiceParams);
      }

      if (
        args.upsertObjects &&
        typeof args.upsertObjects === 'object' &&
        !Array.isArray(args.upsertObjects)
      ) {
        const updatedBoard = await runWithMcpTenantDatabaseScope(ctx, () =>
          boardsService.batchUpsertBoardObjects(
            boardId,
            args.upsertObjects as unknown as unknown[],
            ctx.baseServiceParams
          )
        );
        emitServiceEvent(ctx.app, {
          path: 'boards',
          event: 'patched',
          data: updatedBoard,
          id: boardId,
        });
      }

      if (args.removeObjects && Array.isArray(args.removeObjects)) {
        let finalBoard: Board | undefined;
        for (const objectId of args.removeObjects) {
          finalBoard = await runWithMcpTenantDatabaseScope(ctx, () =>
            boardsService.removeBoardObject(boardId, objectId, ctx.baseServiceParams)
          );
        }
        if (finalBoard)
          emitServiceEvent(ctx.app, {
            path: 'boards',
            event: 'patched',
            data: finalBoard,
            id: boardId,
          });
      }

      const board = await ctx.app.service('boards').get(boardId, ctx.baseServiceParams);
      return textResult({ board, note: 'Board updated successfully.' });
    }
  );

  server.registerTool(
    'agor_boards_permissions_update',
    {
      description:
        'Replace a board permission policy and its complete default branch configuration. ' +
        'Read the current revision with agor_boards_get first. Primary ownership is immutable.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        permissions: boardCapabilityPoliciesSchema,
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId)!;
      const permissions = await ctx.app
        .service('boards/:id/permissions')
        .patch(null, args.permissions, { ...ctx.baseServiceParams, route: { id: boardId } });
      return textResult(permissions);
    }
  );

  // Tool 4: agor_boards_auto_arrange
  server.registerTool(
    'agor_boards_auto_arrange',
    {
      description:
        'Arrange worktrees/branches and cards on a board in a dimension-aware row-major grid. ' +
        'By default, only free-floating entities are moved; zone-pinned entities stay in their zones. ' +
        'Set includeCanvasObjects=true to include text, markdown, apps, and artifacts, and includeZones=true to arrange zones as movable containers. ' +
        'Unless startY is given explicitly, the grid is placed clear of every existing zone rectangle instead of on top of one. ' +
        'Use this after creating or moving many board items so the canvas is tidy and collision-free.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        entityType: z
          .enum(BOARD_ENTITY_TYPES)
          .optional()
          .describe('Arrange only branch or card entities (default: both).'),
        includeArchived: z
          .boolean()
          .optional()
          .describe(
            'Include archived branches and cards. Defaults to false so layout matches the visible board.'
          ),
        includePinned: z
          .boolean()
          .optional()
          .describe('Also move entities currently pinned to zones (default: false).'),
        includeCanvasObjects: z
          .boolean()
          .optional()
          .describe(
            'Also arrange text, markdown, app, and artifact canvas objects (default: false).'
          ),
        includeZones: z
          .boolean()
          .optional()
          .describe(
            'Also arrange zone containers. Their pinned children move with their parent zone.'
          ),
        columns: mcpOptionalPositiveInt(
          'columns',
          'Number of columns in the grid (default: square-ish layout).'
        ),
        startX: mcpOptionalNumber('startX', 'Canvas X origin (default: 80).'),
        startY: mcpOptionalNumber(
          'startY',
          'Canvas Y origin. When omitted, the grid starts at 80 unless that would place it over an existing zone, in which case it drops below every zone and reports avoidedZoneIds. Pass a value to place the grid exactly, including over a zone.'
        ),
        gapX: mcpOptionalNumber('gapX', 'Horizontal gap between cards (default: 40).'),
        gapY: mcpOptionalNumber('gapY', 'Vertical gap between cards (default: 40).'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      if (!boardId) throw new Error('boardId is required');
      const boardObjectsService = ctx.app.service('board-objects');
      const result = (await boardObjectsService.find({
        query: {
          board_id: boardId,
          ...(args.entityType ? { entity_type: args.entityType } : {}),
        },
        ...ctx.baseServiceParams,
      })) as { data: Array<BoardEntityObject> };
      const visibleEntities = await filterVisibleBoardEntities(
        ctx,
        result.data,
        args.includeArchived === true
      );
      const entities = visibleEntities
        .filter((entity) => args.includePinned === true || !entity.zone_id)
        .sort(compareBoardEntitiesSpatially);
      const requestedStartX = args.startX ?? DEFAULT_ARRANGE_START_X;
      const requestedStartY = args.startY ?? DEFAULT_ARRANGE_START_Y;
      const gapX = args.gapX ?? 40;
      const gapY = args.gapY ?? 40;
      const items: Array<{
        id: string;
        kind: 'entity' | 'canvas';
        entity?: BoardEntityObject;
        object?: BoardObject;
        x: number;
        y: number;
        width: number;
        height: number;
      }> = [];
      const unusableSizeObjectIds: string[] = [];
      for (const entity of entities) {
        if (hasUnusableSize(entity)) unusableSizeObjectIds.push(entity.object_id);
        let entityDimensions: { width: number; height: number };
        const measured = measuredSize(entity);
        if (measured) {
          entityDimensions = measured;
        } else if (entity.entity_type === 'card' && entity.card_id) {
          const card = (await ctx.app
            .service('cards')
            .get(entity.card_id, ctx.baseServiceParams)) as {
            title?: string;
            description?: string;
            note?: string;
          };
          entityDimensions = {
            width: ARRANGE_DIMENSIONS.card.width,
            height: estimateCardHeight(card),
          };
        } else {
          entityDimensions = ARRANGE_DIMENSIONS[entity.entity_type];
        }
        items.push({
          id: entity.object_id,
          kind: 'entity',
          entity,
          ...entity.position,
          ...entityDimensions,
        });
      }
      // The board is read even when no canvas object is being arranged: its
      // zone rectangles are what the free-floating grid has to stay clear of.
      const boardsService = ctx.app.service('boards');
      const board = (await boardsService.get(boardId, ctx.baseServiceParams)) as Board;
      for (const [objectId, object] of Object.entries(board.objects ?? {})) {
        if (object.type === 'zone' && args.includeZones !== true) continue;
        if (object.type !== 'zone' && args.includeCanvasObjects !== true) continue;
        items.push({
          id: objectId,
          kind: 'canvas',
          object,
          x: object.x,
          y: object.y,
          ...getCanvasObjectDimensions(object),
        });
      }
      items.sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
      const layout = layoutRectangles(
        items.map(({ id, width, height }) => ({ id, width, height })),
        {
          preferredColumns: args.columns ?? Math.ceil(Math.sqrt(Math.max(1, items.length))),
          gapX,
          gapY,
        }
      );
      const { startX, startY, avoidedZoneIds } = resolveArrangeOrigin({
        startX: requestedStartX,
        startY: requestedStartY,
        explicitStartY: args.startY !== undefined,
        layout,
        gapY,
        obstacles: zoneObstacles(board, args.includeZones === true),
      });
      const placementById = new Map(
        layout.placements.map((placement) => [placement.id, placement])
      );
      const updates: Array<{
        objectId: string;
        objectType: string;
        entityType?: string;
        position: { x: number; y: number };
      }> = [];

      for (const item of items) {
        const placement = placementById.get(item.id);
        if (!placement) throw new Error(`Layout did not place board object '${item.id}'.`);
        const position = {
          x: startX + placement.x,
          y: startY + placement.y,
        };
        if (item.kind === 'entity' && item.entity) {
          await boardObjectsService.patch(item.id, { position }, ctx.baseServiceParams);
          updates.push({
            objectId: item.id,
            objectType: item.entity.entity_type,
            entityType: item.entity.entity_type,
            position,
          });
        } else if (item.object) {
          await boardsService.patch(
            boardId,
            {
              _action: 'upsertObject',
              objectId: item.id,
              objectData: { ...item.object, ...position },
            },
            ctx.baseServiceParams
          );
          updates.push({ objectId: item.id, objectType: item.object.type, position });
        }
      }

      return textResult({
        boardId,
        arranged: updates.length,
        arrangedEntities: updates.filter((update) =>
          BOARD_ENTITY_TYPES.includes(update.objectType as BoardEntityType)
        ).length,
        arrangedCanvasObjects: updates.filter(
          (update) => !BOARD_ENTITY_TYPES.includes(update.objectType as BoardEntityType)
        ).length,
        skippedPinned: visibleEntities.length - entities.length,
        skippedArchived: result.data.length - visibleEntities.length,
        columns: layout.columns,
        rows: layout.rows,
        layoutMode: layout.mode,
        fitsWithoutOverlap: layout.fitsWithoutOverlap,
        width: layout.width,
        height: layout.height,
        appliedGapX: layout.gapX,
        appliedGapY: layout.gapY,
        appliedStartX: startX,
        appliedStartY: startY,
        avoidedZoneIds,
        unusableSizeObjectIds,
        warning:
          [
            avoidedZoneIds.length > 0
              ? `The default grid origin would have covered ${avoidedZoneIds.length} existing zone(s); the grid was placed below every zone at y=${startY}. Pass startY to override.`
              : null,
            unusableSizeObjectIds.length > 0
              ? `Ignored an unusable persisted size on ${unusableSizeObjectIds.join(', ')} and laid them out at the nominal size for their kind.`
              : null,
          ]
            .filter(Boolean)
            .join(' ') || null,
        updates,
      });
    }
  );

  // agor_boards_auto_arrange_zone
  server.registerTool(
    'agor_boards_auto_arrange_zone',
    {
      description:
        'Arrange worktrees/branches and cards inside one board zone using their measured rendered rectangles. Positions are relative to the zone and ordered top-left, left-to-right, then row-by-row. A fully separated grid is always preferred, including compact edge margins and gaps when needed. columns is a target by default: when it cannot fit, the nearest contained non-overlapping grid is used and reported. Set strictColumns for a hard column count. If no grid can fit, the default is no position changes. An accessible cascade deck is available only through explicit overflowStrategy:"deck". The result reports exact containment and overflow.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        zoneId: mcpRequiredString('zoneId', 'Zone object ID'),
        entityType: z
          .enum(BOARD_ENTITY_TYPES)
          .optional()
          .describe('Arrange only branch or card entities (default: both).'),
        includeArchived: z
          .boolean()
          .optional()
          .describe(
            'Include archived branches and cards. Defaults to false so layout matches the visible board.'
          ),
        columns: mcpOptionalPositiveInt(
          'columns',
          'Target number of occupied columns (capped by the number of entities). When omitted, the solver chooses automatically. If this target cannot fit without overlap, the nearest contained grid is used unless strictColumns is true.'
        ),
        strictColumns: z
          .boolean()
          .optional()
          .describe(
            'Require columns exactly as requested. Defaults to false, which allows a reported non-overlapping grid fallback.'
          ),
        overflowStrategy: z
          .enum(['fail', 'deck'])
          .optional()
          .describe(
            'Behavior only when no non-overlapping grid fits. Defaults to fail (no board changes). Use deck only when deliberate visible-header overlap is acceptable.'
          ),
        preset: z
          .enum(ZONE_LAYOUT_PRESETS)
          .optional()
          .describe(
            'Layout presentation. grid preserves current card density; compact_list collapses cards/worktrees and uses one column.'
          ),
        sortBy: z
          .enum(ZONE_LAYOUT_SORT_FIELDS)
          .optional()
          .describe(
            'Order items by current position, priority/rank, workflow status, updated time, created time, or title. Defaults to the zone policy, then position.'
          ),
        sortDirection: z
          .enum(ZONE_LAYOUT_SORT_DIRECTIONS)
          .optional()
          .describe('Ascending or descending sort order. Defaults to the zone policy, then asc.'),
        autoResizeHeight: z
          .boolean()
          .optional()
          .describe(
            'Resize the zone vertically to contain the layout. Defaults to the zone policy, then false.'
          ),
        padding: mcpOptionalNumber('padding', 'Padding from the zone edges (default: 24).'),
        gapX: mcpOptionalNumber('gapX', 'Horizontal gap between items (default: 24).'),
        gapY: mcpOptionalNumber('gapY', 'Vertical gap between items (default: 24).'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      const zoneId = coerceString(args.zoneId);
      if (!boardId || !zoneId) throw new Error('boardId and zoneId are required');
      const board = (await ctx.app.service('boards').get(boardId, ctx.baseServiceParams)) as Board;
      const zone = board.objects?.[zoneId] as
        | (BoardObject & { type: 'zone'; width: number; height: number })
        | undefined;
      if (zone?.type !== 'zone') {
        throw new Error(`Zone '${zoneId}' was not found on board '${boardId}'.`);
      }

      const zonePolicy = normalizeZoneLayoutPolicy({
        ...zone.layout,
        ...(args.preset === undefined ? {} : { preset: args.preset }),
        ...(args.sortBy === undefined ? {} : { sortBy: args.sortBy }),
        ...(args.sortDirection === undefined ? {} : { sortDirection: args.sortDirection }),
        ...(args.columns === undefined ? {} : { columns: args.columns }),
        ...(args.autoResizeHeight === undefined ? {} : { autoResizeHeight: args.autoResizeHeight }),
      });

      const boardObjectsService = ctx.app.service('board-objects');
      const result = (await boardObjectsService.find({
        query: {
          board_id: boardId,
          zone_id: zoneId,
          ...(args.entityType ? { entity_type: args.entityType } : {}),
        },
        ...ctx.baseServiceParams,
      })) as { data: Array<BoardEntityObject> };
      let entities = await filterVisibleBoardEntities(
        ctx,
        result.data,
        args.includeArchived === true
      );
      const metadataEntities = entities.filter(
        (entity) =>
          zonePolicy.sortBy !== 'position' ||
          (zonePolicy.preset === 'grid' &&
            entity.compact !== true &&
            measuredSize(entity) === undefined &&
            entity.card_id !== undefined)
      );
      const metadata = await loadEntityLayoutMetadata(ctx, metadataEntities);
      entities = sortZoneLayoutItems(
        entities.map((entity) => ({
          entity,
          ...(metadata.get(entity.object_id) ?? {
            id: entity.object_id,
            position: entity.position,
          }),
        })),
        zonePolicy
      ).map(({ entity }) => entity);
      const dimensions = new Map<string, { width: number; height: number }>();
      const unusableSizeObjectIds: string[] = [];
      for (const entity of entities) {
        if (hasUnusableSize(entity)) unusableSizeObjectIds.push(entity.object_id);
        const measured = measuredSize(entity);
        if (zonePolicy.preset === 'compact_list' || entity.compact === true) {
          dimensions.set(entity.object_id, COMPACT_ARRANGE_DIMENSIONS[entity.entity_type]);
        } else if (measured) {
          dimensions.set(entity.object_id, measured);
        } else if (entity.entity_type === 'card' && entity.card_id) {
          const card = metadata.get(entity.object_id)?.card;
          dimensions.set(entity.object_id, {
            width: ARRANGE_DIMENSIONS.card.width,
            height: estimateCardHeight(card),
          });
        } else {
          dimensions.set(entity.object_id, ARRANGE_DIMENSIONS[entity.entity_type]);
        }
      }
      const padding = Math.max(0, args.padding ?? 24);
      const gapX = Math.max(0, args.gapX ?? zonePolicy.gap ?? 24);
      const gapY = Math.max(0, args.gapY ?? zonePolicy.gap ?? 24);
      const titleInset = zoneContentTopInset(zone);
      const autoResizeHeight = zonePolicy.autoResizeHeight === true;
      if (entities.length === 0) {
        return textResult({
          boardId,
          zoneId,
          arranged: 0,
          columns: 0,
          rows: 0,
          fitsWithoutOverlap: true,
          layoutMode: 'grid',
          updates: [],
        });
      }
      const layout = layoutRectangles(
        entities.map((entity) => {
          const size = dimensions.get(entity.object_id);
          if (!size) throw new Error(`Missing dimensions for board object '${entity.object_id}'.`);
          return { id: entity.object_id, ...size };
        }),
        {
          // The title/status sits inside the zone, above child nodes. Layout
          // against the remaining rectangle, then translate placements below
          // that reserved header so cards can never cover the title.
          bounds: {
            width: zone.width,
            height: autoResizeHeight
              ? Number.MAX_SAFE_INTEGER
              : Math.max(0, zone.height - titleInset),
          },
          padding,
          minPadding: 8,
          gapX,
          gapY,
          minGapX: 8,
          minGapY: 8,
          ...(zonePolicy.preset === 'compact_list'
            ? { exactColumns: 1 }
            : args.strictColumns === true
              ? { exactColumns: args.columns ?? zonePolicy.columns }
              : { preferredColumns: args.columns ?? zonePolicy.columns }),
          allowDeck: args.overflowStrategy === 'deck',
          deckOffsetX: DECK_OFFSET_X,
          deckOffsetY: DECK_OFFSET_Y,
        }
      );
      const requestedColumns =
        args.columns === undefined ? null : Math.min(args.columns, entities.length);
      if (layout.overflowingItemIds.length > 0) {
        return textResult({
          boardId,
          zoneId,
          applied: false,
          arranged: 0,
          requestedColumns,
          columns: layout.columns,
          rows: layout.rows,
          fitsWithoutOverlap: layout.fitsWithoutOverlap,
          layoutMode: layout.mode,
          requiredWidth: layout.width,
          requiredHeight: layout.height + titleInset,
          reservedTitleHeight: titleInset,
          availableContentHeight: Math.max(0, zone.height - titleInset),
          appliedGapX: layout.gapX,
          appliedGapY: layout.gapY,
          appliedPadding: layout.padding,
          overflowingObjectIds: layout.overflowingItemIds,
          unusableSizeObjectIds,
          warning:
            `One or more rendered objects are larger than the available zone rectangle, or no non-overlapping ${requestedColumns === null ? 'automatic' : `${requestedColumns}-column`} layout can fit every rendered object inside ` +
            `the ${zone.width}×${zone.height} zone. No positions were changed. Increase the zone size, ` +
            'reduce the requested columns, allow a non-strict grid fallback, or explicitly choose overflowStrategy:"deck".',
          zone: { width: zone.width, height: zone.height },
          updates: [],
        });
      }
      const placementById = new Map(
        layout.placements.map((placement) => [placement.id, placement])
      );
      const updates: Array<{
        objectId: string;
        entityType: string;
        position: { x: number; y: number };
        row: number;
        column: number;
        stackIndex: number;
        deckDepth: number;
      }> = [];

      for (const entity of entities) {
        const placement = placementById.get(entity.object_id);
        if (!placement) throw new Error(`Layout did not place board object '${entity.object_id}'.`);
        const position = { x: placement.x, y: placement.y + titleInset };
        if (zonePolicy.preset === 'compact_list' && entity.compact !== true) {
          await boardObjectsService.patch(
            entity.object_id,
            { compact: true },
            ctx.baseServiceParams
          );
        }
        await boardObjectsService.patch(entity.object_id, { position }, ctx.baseServiceParams);
        updates.push({
          objectId: entity.object_id,
          entityType: entity.entity_type,
          position,
          row: placement.row,
          column: placement.column,
          stackIndex: placement.stackIndex,
          deckDepth: placement.deckDepth,
        });
      }

      const appliedZoneHeight = autoResizeHeight
        ? Math.max(200, Math.ceil(layout.height + titleInset))
        : zone.height;
      // A grow moves the bottom edge onto whatever shares the canvas below it.
      // Only a grow can newly cover a neighbour; a shrink or a no-op cannot.
      const resizedOverZoneIds =
        appliedZoneHeight > zone.height
          ? zonesOverlappedBy(board, zoneId, {
              x: zone.x,
              y: zone.y,
              width: zone.width,
              height: appliedZoneHeight,
            })
          : [];
      if (appliedZoneHeight !== zone.height) {
        await ctx.app.service('boards').patch(
          boardId,
          {
            _action: 'upsertObject',
            objectId: zoneId,
            objectData: { ...zone, height: appliedZoneHeight },
          } as unknown as Partial<Board>,
          ctx.baseServiceParams
        );
      }

      return textResult({
        boardId,
        zoneId,
        applied: true,
        arranged: updates.length,
        requestedColumns,
        strictColumns: args.strictColumns === true,
        usedColumnFallback: requestedColumns !== null && layout.columns !== requestedColumns,
        columns: layout.columns,
        rows: layout.rows,
        fitsWithoutOverlap: layout.fitsWithoutOverlap,
        layoutMode: layout.mode,
        preset: zonePolicy.preset,
        sortBy: zonePolicy.sortBy,
        sortDirection: zonePolicy.sortDirection,
        autoResizeHeight,
        deckOffsetX: layout.mode === 'deck' ? layout.deckOffsetX : null,
        deckOffsetY: layout.mode === 'deck' ? layout.deckOffsetY : null,
        stackCount: layout.mode === 'deck' ? layout.stackCount : null,
        maxDeckDepth: layout.maxDeckDepth,
        requiredWidth: layout.width,
        requiredHeight: layout.height + titleInset,
        reservedTitleHeight: titleInset,
        availableContentHeight: Math.max(0, zone.height - titleInset),
        appliedGapX: layout.gapX,
        appliedGapY: layout.gapY,
        appliedPadding: layout.padding,
        overflowingObjectIds: layout.overflowingItemIds,
        unusableSizeObjectIds,
        resizedOverZoneIds,
        warning:
          [
            resizedOverZoneIds.length > 0
              ? `Growing this zone to ${appliedZoneHeight}px now covers ${resizedOverZoneIds.join(', ')}. Run agor_boards_auto_arrange with includeZones:true to separate the zones.`
              : null,
            layout.overflowingItemIds.length > 0
              ? `One or more rendered objects are larger than the available zone rectangle: ${layout.overflowingItemIds.join(', ')}.`
              : layout.mode === 'deck'
                ? `The zone cannot fit every rendered object without overlap; a contained cascade deck was used with ${layout.deckOffsetX}px left-edge and ${layout.deckOffsetY}px header reveals.`
                : requestedColumns !== null && layout.columns !== requestedColumns
                  ? `The requested ${requestedColumns}-column target could not fit without overlap; a contained ${layout.columns}-column grid was used.`
                  : null,
            unusableSizeObjectIds.length > 0
              ? `Ignored an unusable persisted size on ${unusableSizeObjectIds.join(', ')} and laid them out at the nominal size for their kind.`
              : null,
          ]
            .filter(Boolean)
            .join(' ') || null,
        zone: { width: zone.width, height: appliedZoneHeight },
        updates,
      });
    }
  );

  server.registerTool(
    'agor_boards_set_zone_layout',
    {
      description:
        'Configure a zone layout policy. Manual mode preserves spatial memory until Arrange contents is requested. Auto mode maintains the selected ordering and preset as items or measured sizes change. Use grid for cards or compact_list for a collapsible one-row-per-item list.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        zoneId: mcpRequiredString('zoneId', 'Zone object ID'),
        mode: z.enum(ZONE_LAYOUT_MODES),
        preset: z.enum(ZONE_LAYOUT_PRESETS).optional(),
        sortBy: z.enum(ZONE_LAYOUT_SORT_FIELDS).optional(),
        sortDirection: z.enum(ZONE_LAYOUT_SORT_DIRECTIONS).optional(),
        columns: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('Preferred grid columns. Use null to return to automatic column selection.'),
        gap: z
          .number()
          .int()
          .min(0)
          .max(96)
          .optional()
          .describe('Spacing between arranged items in board pixels.'),
        autoResizeHeight: z
          .boolean()
          .optional()
          .describe('Grow or shrink the zone vertically to contain arranged items.'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      const zoneId = coerceString(args.zoneId);
      if (!boardId || !zoneId) throw new Error('boardId and zoneId are required');
      const boardsService = ctx.app.service('boards');
      const board = (await boardsService.get(boardId, ctx.baseServiceParams)) as Board;
      const zone = board.objects?.[zoneId];
      if (zone?.type !== 'zone') {
        throw new Error(`Zone '${zoneId}' was not found on board '${boardId}'.`);
      }
      const layout = normalizeZoneLayoutPolicy({
        ...zone.layout,
        mode: args.mode,
        ...(args.preset === undefined ? {} : { preset: args.preset }),
        ...(args.sortBy === undefined ? {} : { sortBy: args.sortBy }),
        ...(args.sortDirection === undefined ? {} : { sortDirection: args.sortDirection }),
        ...(args.columns === undefined ? {} : { columns: args.columns ?? undefined }),
        ...(args.gap === undefined ? {} : { gap: args.gap }),
        ...(args.autoResizeHeight === undefined ? {} : { autoResizeHeight: args.autoResizeHeight }),
      } satisfies Partial<ZoneLayoutPolicy>);
      const updatedZone = { ...zone, layout };
      await boardsService.patch(
        boardId,
        {
          _action: 'upsertObject',
          objectId: zoneId,
          objectData: updatedZone,
        } as unknown as Partial<Board>,
        ctx.baseServiceParams
      );
      return textResult({ boardId, zoneId, layout, note: 'Zone layout policy updated.' });
    }
  );

  // agor_boards_set_compact
  server.registerTool(
    'agor_boards_set_compact',
    {
      description:
        'Collapse or expand board cards/worktrees in the shared board presentation. Compact cards keep their identity header visible while hiding secondary content, which is useful before arranging a dense board. Target explicit board-object IDs, a zone, an entity type, or the entire board.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        compact: z.boolean().describe('true collapses secondary card content; false expands it.'),
        objectIds: z
          .array(mcpRequiredString('objectId', 'Board object ID'))
          .min(1)
          .optional()
          .describe('Specific board placement IDs to update.'),
        zoneId: mcpOptionalString('zoneId', 'Zone object ID'),
        entityType: z
          .enum(BOARD_ENTITY_TYPES)
          .optional()
          .describe('Limit targets to branch/worktree or card placements.'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      if (!boardId) throw new Error('boardId is required');
      const boardObjectsService = ctx.app.service('board-objects');
      const requestedIds = new Set(args.objectIds ?? []);
      const found = (await boardObjectsService.find({
        query: {
          board_id: boardId,
          ...(args.zoneId ? { zone_id: args.zoneId } : {}),
          ...(args.entityType ? { entity_type: args.entityType } : {}),
        },
        ...ctx.baseServiceParams,
      })) as { data: Array<BoardEntityObject> };
      const targets = requestedIds.size
        ? found.data.filter((object) => requestedIds.has(object.object_id))
        : found.data;
      if (requestedIds.size && targets.length !== requestedIds.size) {
        throw new Error('One or more board object IDs do not belong to this accessible board.');
      }
      if (targets.length === 0) {
        return textResult({ boardId, compact: args.compact, updated: 0, updates: [] });
      }
      const updates = await Promise.all(
        targets.map(async (object) => {
          const updated = (await boardObjectsService.patch(
            object.object_id,
            { compact: args.compact },
            ctx.baseServiceParams
          )) as BoardEntityObject;
          return {
            objectId: updated.object_id,
            entityType: updated.entity_type,
            compact: updated.compact === true,
          };
        })
      );
      return textResult({ boardId, compact: args.compact, updated: updates.length, updates });
    }
  );

  // agor_boards_create
  server.registerTool(
    'agor_boards_create',
    {
      description: 'Create a new board. Returns the created board object with its ID and URL.',
      inputSchema: z.object({
        name: mcpRequiredString('name', 'Board name (required)'),
        slug: mcpOptionalString(
          'slug',
          'URL-friendly slug (optional, auto-derived from name if not provided)'
        ),
        description: mcpOptionalString('description', 'Board description (optional)'),
        icon: mcpOptionalString(
          'icon',
          'Board icon/emoji (optional, e.g. "📋"). Unicode emoji is preferred; common exact shortcodes like ":compass:" are accepted and normalized.'
        ),
        color: mcpOptionalString('color', 'Board color in hex format (optional)'),
        backgroundColor: mcpOptionalString(
          'backgroundColor',
          'Board background color in hex format (optional)'
        ),
        customCss: mcpOptionalString(
          'customCss',
          'Custom CSS for board canvas animations (@keyframes, animation, etc.). Optional.'
        ),
        defaultOthersCan: z.enum(BRANCH_PERMISSION_LEVELS).optional(),
        defaultOthersFsAccess: z.enum(['none', 'read', 'write']).optional(),
      }),
    },
    async (args) => {
      const boardName = coerceString(args.name);
      if (!boardName) throw new Error('name is required');

      const boardData: Record<string, unknown> = {
        name: boardName,
        created_by: ctx.userId,
      };
      if (args.slug !== undefined) boardData.slug = coerceString(args.slug);
      if (args.description !== undefined) boardData.description = coerceString(args.description);
      if (args.icon !== undefined) boardData.icon = coerceString(args.icon);
      if (args.color !== undefined) boardData.color = coerceString(args.color);
      if (args.backgroundColor !== undefined)
        boardData.background_color = coerceString(args.backgroundColor);
      if (args.customCss !== undefined) boardData.custom_css = coerceString(args.customCss);
      if (args.defaultOthersCan !== undefined) boardData.default_others_can = args.defaultOthersCan;
      if (args.defaultOthersFsAccess !== undefined)
        boardData.default_others_fs_access = args.defaultOthersFsAccess;

      const board = await ctx.app.service('boards').create(boardData, ctx.baseServiceParams);
      return textResult(board);
    }
  );

  // agor_boards_archive
  server.registerTool(
    'agor_boards_archive',
    {
      description:
        'Archive a board (soft delete). Archived boards are hidden from listings by default. Use agor_boards_unarchive to restore.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board', 'Board ID to archive (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId)!;
      const boardsService = ctx.app.service('boards') as unknown as BoardsServiceImpl;
      // archive() is a custom (non-transport) method that reads/patches over
      // `this.db` without an internal scope helper, so re-enter the tenant DB
      // scope here (the HTTP archive route enters it via its around hook).
      const result = await runWithMcpTenantDatabaseWrite(ctx, () =>
        boardsService.archive(boardId, ctx.baseServiceParams)
      );
      return textResult({
        success: true,
        board: result,
        message: 'Board archived successfully.',
      });
    }
  );

  // agor_boards_unarchive
  server.registerTool(
    'agor_boards_unarchive',
    {
      description: 'Restore a previously archived board. The board will appear in listings again.',
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board', 'Board ID to unarchive (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId)!;
      const boardsService = ctx.app.service('boards') as unknown as BoardsServiceImpl;
      // Custom (non-transport) method — enter the tenant DB scope like the HTTP
      // unarchive route's around hook would.
      const result = await runWithMcpTenantDatabaseWrite(ctx, () =>
        boardsService.unarchive(boardId, ctx.baseServiceParams)
      );
      return textResult({
        success: true,
        board: result,
        message: 'Board unarchived successfully.',
      });
    }
  );

  // agor_boards_arrange_zones
  server.registerTool(
    'agor_boards_arrange_zones',
    {
      description:
        "Arrange a board's zones themselves into justified rows, photo-grid style: zones flow left-to-right and top-to-bottom, every zone in a row shares that row's height, and each full row is stretched flush to targetWidth. Zone widths and heights are both rewritten, so a zone becomes portrait or landscape depending on which shape lets its own contents fit the row. Pinned contents move with their zone; call agor_boards_auto_arrange_zone afterwards to re-pack the items inside each zone at its new width. Use targetRowHeight to stop one tall zone from dictating a row.",
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        targetWidth: mcpOptionalPositiveInt(
          'targetWidth',
          'Width each full row is stretched to (default: 1600).'
        ),
        targetRowHeight: mcpOptionalPositiveInt(
          'targetRowHeight',
          'Preferred row height. Without it, a tall zone can be packed beside a short one and leave the short one mostly blank.'
        ),
        gap: mcpOptionalNonNegativeInt('gap', 'Space between zones (default: 40).'),
        startX: mcpOptionalNumber('startX', 'Canvas X origin (default: 80).'),
        startY: mcpOptionalNumber('startY', 'Canvas Y origin (default: 80).'),
        maxPerRow: mcpOptionalPositiveInt('maxPerRow', 'Upper bound on zones per row.'),
        justifyLastRow: z
          .boolean()
          .optional()
          .describe(
            'Stretch the final row even when it is underfull (default: false, matching a photo grid).'
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe('Compute and return the layout without writing any zone.'),
      }),
    },
    async (args) => {
      const boardId = coerceString(args.boardId);
      if (!boardId) throw new Error('boardId is required');
      const board = (await ctx.app.service('boards').get(boardId, ctx.baseServiceParams)) as Board;

      const zoneEntries = Object.entries(board.objects ?? {}).filter(
        ([, object]) => object.type === 'zone'
      ) as [string, BoardObject & { type: 'zone'; width: number; height: number }][];

      if (zoneEntries.length === 0) {
        return textResult({
          boardId,
          arranged: 0,
          rows: 0,
          updates: [],
          note: 'No zones present.',
        });
      }

      const boardObjectsService = ctx.app.service('board-objects');
      const entityResult = (await boardObjectsService.find({
        query: { board_id: boardId },
        ...ctx.baseServiceParams,
      })) as { data: Array<BoardEntityObject> };
      const visible = await filterVisibleBoardEntities(ctx, entityResult.data, false);

      // Size each zone's contents the way the zone arrange does, so the shapes
      // we choose between are ones the zone can genuinely hold.
      const zones = await Promise.all(
        zoneEntries.map(async ([zoneId, zone]) => {
          const contents = visible.filter((entity) => entity.zone_id === zoneId);
          const metadata = await loadEntityLayoutMetadata(
            ctx,
            contents.filter((entity) => entity.card_id !== undefined && !measuredSize(entity))
          );
          const items = contents.map((entity) => {
            const measured = measuredSize(entity);
            if (entity.compact === true) {
              return { id: entity.object_id, ...COMPACT_ARRANGE_DIMENSIONS[entity.entity_type] };
            }
            if (measured) return { id: entity.object_id, ...measured };
            if (entity.entity_type === 'card' && entity.card_id) {
              return {
                id: entity.object_id,
                width: ARRANGE_DIMENSIONS.card.width,
                height: estimateCardHeight(metadata.get(entity.object_id)?.card),
              };
            }
            return { id: entity.object_id, ...ARRANGE_DIMENSIONS[entity.entity_type] };
          });
          return {
            id: zoneId,
            zone,
            itemCount: items.length,
            shapes: zoneShapesForItems(items, {
              titleInset: zoneContentTopInset(zone),
              padding: Math.max(0, args.gap ?? 24),
              gapX: 24,
              gapY: 24,
            }),
          };
        })
      );

      const layout = layoutJustifiedZones(zones, {
        targetWidth: args.targetWidth ?? 1600,
        targetRowHeight: args.targetRowHeight,
        gap: args.gap ?? 40,
        startX: args.startX ?? 80,
        startY: args.startY ?? 80,
        maxPerRow: args.maxPerRow,
        justifyLastRow: args.justifyLastRow === true,
      });

      const byId = new Map(zones.map((entry) => [entry.id, entry]));
      if (args.dryRun !== true) {
        for (const placement of layout.placements) {
          const entry = byId.get(placement.id);
          if (!entry) continue;
          await ctx.app.service('boards').patch(
            boardId,
            {
              _action: 'upsertObject',
              objectId: placement.id,
              objectData: {
                ...entry.zone,
                x: placement.x,
                y: placement.y,
                width: placement.width,
                height: placement.height,
              },
            } as unknown as Partial<Board>,
            ctx.baseServiceParams
          );
        }
      }

      return textResult({
        boardId,
        arranged: layout.placements.length,
        rows: layout.rows,
        width: layout.width,
        height: layout.height,
        gap: layout.gap,
        rowHeights: layout.rowHeights,
        dryRun: args.dryRun === true,
        overflowingRows: layout.overflowingRows,
        warning:
          layout.overflowingRows.length > 0
            ? `Row(s) ${layout.overflowingRows.join(', ')} hold a zone wider than targetWidth even at its narrowest shape; they were left at their natural width. Raise targetWidth or move a zone.`
            : null,
        note: 'Zone contents keep their zone-relative positions. Run agor_boards_auto_arrange_zone on each zone to re-pack items at the new width.',
        updates: layout.placements.map((placement) => ({
          objectId: placement.id,
          label: byId.get(placement.id)?.zone.label ?? null,
          itemCount: byId.get(placement.id)?.itemCount ?? 0,
          position: { x: placement.x, y: placement.y },
          size: { width: placement.width, height: placement.height },
          row: placement.row,
          column: placement.column,
          contentColumns: placement.columns,
          slackY: placement.slackY,
        })),
      });
    }
  );
}
