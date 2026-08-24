import type {
  Board,
  BoardEntityObject,
  BoardEntityType,
  BoardObject,
  BoardObjectType,
  BranchID,
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
import { runWithMcpTenantDatabaseScope } from '../tenant-scope.js';

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
  card: { width: 380, height: 150 },
} as const;
const DECK_OFFSET = 2;

/**
 * CardNode grows with its description and (unlike the React Flow placeholder
 * height) renders the note in full. Estimate the rendered rectangle from the
 * persisted content before laying out. This is deliberately conservative: a
 * false overflow warning is preferable to putting the bottom of a card
 * outside its zone.
 */
function estimateCardHeight(card: { title?: string; description?: string; note?: string }): number {
  const lineCount = (value: string | undefined, charsPerLine: number) =>
    value ? Math.max(1, Math.ceil(value.length / charsPerLine)) : 0;
  const header = 50;
  const description = card.description
    ? 16 +
      lineCount(card.description.slice(0, 100), 48) * 18 +
      (card.description.length > 100 ? 18 : 0)
    : 0;
  const note = card.note ? 16 + lineCount(card.note, 48) * 18 : 0;
  return Math.max(ARRANGE_DIMENSIONS.card.height, header + description + note);
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
        'Arrange the worktree/branch and card entities on a board in a deterministic grid. ' +
        'By default, only free-floating entities are moved; zone-pinned entities stay in their zones. ' +
        'Use this after creating or moving many worktrees/cards so the canvas is tidy and collision-free.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        entityType: z
          .enum(BOARD_ENTITY_TYPES)
          .optional()
          .describe('Arrange only branch or card entities (default: both).'),
        includePinned: z
          .boolean()
          .optional()
          .describe('Also move entities currently pinned to zones (default: false).'),
        columns: mcpOptionalPositiveInt(
          'columns',
          'Number of columns in the grid (default: square-ish layout).'
        ),
        startX: mcpOptionalNumber('startX', 'Canvas X origin (default: 80).'),
        startY: mcpOptionalNumber('startY', 'Canvas Y origin (default: 80).'),
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
      const entities = result.data
        .filter((entity) => args.includePinned === true || !entity.zone_id)
        .sort((a, b) => a.object_id.localeCompare(b.object_id));
      const columns = Math.max(
        1,
        args.columns ?? Math.ceil(Math.sqrt(Math.max(1, entities.length)))
      );
      const startX = args.startX ?? 80;
      const startY = args.startY ?? 80;
      const gapX = args.gapX ?? 40;
      const gapY = args.gapY ?? 40;
      const updates: Array<{
        objectId: string;
        entityType: string;
        position: { x: number; y: number };
      }> = [];

      for (const [index, entity] of entities.entries()) {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const position = {
          x: startX + column * (500 + gapX),
          y: startY + row * (220 + gapY),
        };
        await boardObjectsService.patch(entity.object_id, { position }, ctx.baseServiceParams);
        updates.push({ objectId: entity.object_id, entityType: entity.entity_type, position });
      }

      return textResult({
        boardId,
        arranged: updates.length,
        skippedPinned: result.data.length - entities.length,
        columns,
        updates,
      });
    }
  );

  // Tool 5: agor_boards_auto_arrange_zone
  server.registerTool(
    'agor_boards_auto_arrange_zone',
    {
      description:
        'Arrange worktrees/branches and cards inside one board zone. Positions are stored relative to the zone, preserving the zone pin. Items are placed row-major from top-left; a zone that cannot fit every rendered rectangle switches to a deterministic 2px-offset deck instead of collapsing items onto one coordinate. The result reports fitsWithoutOverlap and layoutMode.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board'),
        zoneId: mcpRequiredString('zoneId', 'Zone object ID'),
        entityType: z
          .enum(BOARD_ENTITY_TYPES)
          .optional()
          .describe('Arrange only branch or card entities (default: both).'),
        columns: mcpOptionalPositiveInt(
          'columns',
          'Number of columns; defaults to the largest number that fits the zone width.'
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

      const boardObjectsService = ctx.app.service('board-objects');
      const result = (await boardObjectsService.find({
        query: {
          board_id: boardId,
          zone_id: zoneId,
          ...(args.entityType ? { entity_type: args.entityType } : {}),
        },
        ...ctx.baseServiceParams,
      })) as { data: Array<BoardEntityObject> };
      const entities = result.data.sort((a, b) => a.object_id.localeCompare(b.object_id));
      const dimensions = new Map<string, { width: number; height: number }>();
      for (const entity of entities) {
        if (entity.entity_type === 'card' && entity.card_id) {
          const card = (await ctx.app
            .service('cards')
            .get(entity.card_id, ctx.baseServiceParams)) as {
            title?: string;
            description?: string;
            note?: string;
          };
          dimensions.set(entity.object_id, {
            width: ARRANGE_DIMENSIONS.card.width,
            height: estimateCardHeight(card),
          });
        } else {
          dimensions.set(entity.object_id, ARRANGE_DIMENSIONS[entity.entity_type]);
        }
      }
      const padding = Math.max(0, args.padding ?? 24);
      const gapX = Math.max(0, args.gapX ?? 24);
      const gapY = Math.max(0, args.gapY ?? 24);
      const maxWidth = entities.reduce(
        (width, entity) => Math.max(width, dimensions.get(entity.object_id)?.width ?? 0),
        0
      );
      const maxColumns = Math.max(
        1,
        Math.floor((Math.max(0, zone.width - 2 * padding) + gapX) / (maxWidth + gapX))
      );
      const columns = Math.max(1, Math.min(args.columns ?? maxColumns, maxColumns));
      const rows = Math.ceil(entities.length / columns);
      const rowHeights = Array.from({ length: rows }, (_, row) =>
        Math.max(
          0,
          ...entities
            .slice(row * columns, (row + 1) * columns)
            .map((entity) => dimensions.get(entity.object_id)?.height ?? 0)
        )
      );
      const availableHeight = Math.max(0, zone.height - 2 * padding);
      const totalRowHeight = rowHeights.reduce((sum, height) => sum + height, 0);
      const requiredHeight = totalRowHeight + Math.max(0, rows - 1) * gapY;
      const fitsWithoutOverlap = requiredHeight <= availableHeight;
      const rowOffsets = fitsWithoutOverlap
        ? rowHeights.map(
            (_, row) =>
              padding + rowHeights.slice(0, row).reduce((sum, height) => sum + height + gapY, 0)
          )
        : rowHeights.map((_, row) => padding + row * DECK_OFFSET);
      const overflowingObjectIds = entities
        .filter((entity, index) => {
          const row = Math.floor(index / columns);
          return (
            (rowOffsets[row] ?? padding) + (dimensions.get(entity.object_id)?.height ?? 0) >
            zone.height - padding
          );
        })
        .map((entity) => entity.object_id);
      const updates: Array<{
        objectId: string;
        entityType: string;
        position: { x: number; y: number };
      }> = [];

      for (const [index, entity] of entities.entries()) {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const entityWidth = dimensions.get(entity.object_id)?.width ?? maxWidth;
        const position = {
          x: Math.min(padding + column * (maxWidth + gapX), Math.max(0, zone.width - entityWidth)),
          // Clamp the persisted origin as a final safety net. If the content
          // cannot fit, cards may overlap, but their full rectangles remain
          // visible inside the zone and overflowingObjectIds explains why.
          y: Math.min(
            rowOffsets[row] ?? padding,
            Math.max(0, zone.height - padding - (dimensions.get(entity.object_id)?.height ?? 0))
          ),
        };
        await boardObjectsService.patch(entity.object_id, { position }, ctx.baseServiceParams);
        updates.push({ objectId: entity.object_id, entityType: entity.entity_type, position });
      }

      return textResult({
        boardId,
        zoneId,
        arranged: updates.length,
        columns,
        rows,
        fitsWithoutOverlap: fitsWithoutOverlap && overflowingObjectIds.length === 0,
        layoutMode: fitsWithoutOverlap ? 'grid' : 'deck',
        deckOffset: fitsWithoutOverlap ? null : DECK_OFFSET,
        requiredHeight,
        overflowingObjectIds,
        zone: { width: zone.width, height: zone.height },
        updates,
      });
    }
  );

  // Tool 6: agor_boards_create
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

  // Tool 5: agor_boards_archive
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
      const result = await boardsService.archive(boardId, ctx.baseServiceParams);
      return textResult({
        success: true,
        board: result,
        message: 'Board archived successfully.',
      });
    }
  );

  // Tool 6: agor_boards_unarchive
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
      const result = await boardsService.unarchive(boardId, ctx.baseServiceParams);
      return textResult({
        success: true,
        board: result,
        message: 'Board unarchived successfully.',
      });
    }
  );
}
