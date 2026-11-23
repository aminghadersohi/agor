import { BoardObjectRepository } from '@agor/core/db';
import type { Card, ZoneBoardObject } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CardArchiveResult, CardsService, CardUnarchiveResult } from '../../services/cards.js';
import { emitServiceEvent } from '../../utils/emit-service-event.js';
import { entityColorOverrideDescription, parseEntityColorOverride } from '../entity-color.js';
import { resolveBoardId, resolveCardId } from '../resolve-ids.js';
import {
  mcpLimit,
  mcpOffset,
  mcpOptionalId,
  mcpOptionalString,
  mcpPageResult,
  mcpRequiredId,
  mcpRequiredNumber,
  mcpRequiredString,
} from '../schema.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope } from '../tenant-scope.js';

const CARD_COLOR_OVERRIDE_DESCRIPTION = entityColorOverrideDescription('this card');

const ARCHIVED_UPDATE_DESCRIPTION =
  'true archives the card (hidden from the board, data kept, reversible); false unarchives it and re-places it on the board if its placement was removed. Prefer archiving over agor_cards_delete for finished cards.';

/**
 * Archive or unarchive one card through the service (which runs the board
 * mutate check) and publish what changed: the card itself, plus any placement
 * the change removed or recreated.
 */
async function applyCardArchiveChange(
  ctx: McpContext,
  cardId: string,
  archived: boolean,
  options: { removeFromBoard?: boolean; restorePlacement?: boolean } = {}
): Promise<CardArchiveResult & CardUnarchiveResult> {
  const cardsService = ctx.app.service('cards') as unknown as CardsService;
  const result: CardArchiveResult & CardUnarchiveResult = await runWithMcpTenantDatabaseScope(
    ctx,
    () =>
      archived
        ? cardsService.archive(cardId, ctx.baseServiceParams, {
            removeFromBoard: options.removeFromBoard,
          })
        : cardsService.unarchive(cardId, ctx.baseServiceParams, {
            restorePlacement: options.restorePlacement,
          })
  );
  emitServiceEvent(ctx.app, {
    path: 'cards',
    event: 'patched',
    data: result.card,
    id: result.card.card_id,
  });
  if (result.removedBoardObject) {
    emitServiceEvent(ctx.app, {
      path: 'board-objects',
      event: 'removed',
      data: result.removedBoardObject,
      id: result.removedBoardObject.object_id,
    });
  }
  if (result.createdBoardObject) {
    emitServiceEvent(ctx.app, {
      path: 'board-objects',
      event: 'created',
      data: result.createdBoardObject,
    });
  }
  return result;
}

/** Card fields an update may change, other than the archive state. */
function cardPatchData(update: {
  title?: string;
  url?: string | null;
  description?: string | null;
  note?: string | null;
  data?: Record<string, unknown> | null;
  emojiOverride?: string | null;
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (update.title !== undefined) patch.title = update.title;
  if (update.url !== undefined) patch.url = update.url;
  if (update.description !== undefined) patch.description = update.description;
  if (update.note !== undefined) patch.note = update.note;
  if (update.data !== undefined) patch.data = update.data;
  if (update.emojiOverride !== undefined) patch.emoji_override = update.emojiOverride;
  return patch;
}

/**
 * Apply one card update: metadata through the transport patch (hooks + realtime),
 * then the archive state through the service so archived_at and placement stay
 * consistent. Returns the card as it stands after both.
 */
async function applyCardUpdate(
  ctx: McpContext,
  cardId: string,
  patch: Record<string, unknown>,
  archived: boolean | undefined
): Promise<Card> {
  let card: Card | undefined;
  if (Object.keys(patch).length > 0 || archived === undefined) {
    card = (await ctx.app.service('cards').patch(cardId, patch, ctx.baseServiceParams)) as Card;
  }
  if (archived === undefined) return card!;
  return (await applyCardArchiveChange(ctx, card?.card_id ?? cardId, archived)).card;
}

export function registerCardTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_cards_create
  server.registerTool(
    'agor_cards_create',
    {
      description:
        'Create a new card on a board. Creates both the card entity and its board placement in one operation. If zoneId is provided, the card is placed directly in that zone with automatic positioning.',
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board', 'Board ID where the card will be created'),
        title: mcpRequiredString('title', 'Card title'),
        cardTypeId: mcpOptionalId('cardTypeId', 'Card type', 'Card type ID (optional)'),
        zoneId: mcpOptionalId('zoneId', 'Zone', 'Zone ID to place the card in (optional)'),
        url: mcpOptionalString('url', 'URL associated with the card (optional)'),
        description: mcpOptionalString('description', 'Card description (optional)'),
        note: mcpOptionalString('note', 'Card note (optional)'),
        data: z.object({}).passthrough().optional().describe('Custom data object (optional)'),
        colorOverride: mcpOptionalString(
          'colorOverride',
          `${CARD_COLOR_OVERRIDE_DESCRIPTION} Optional.`
        ),
        emojiOverride: mcpOptionalString('emojiOverride', 'Emoji override (optional)'),
      }),
    },
    async (args) => {
      const title = coerceString(args.title)!;
      const colorOverride = parseEntityColorOverride(args.colorOverride);
      // boards.get already resolves exact and short IDs. Reuse the authorized
      // canonical entity instead of resolving it with one get and immediately
      // reading the same board again.
      const board = await ctx.app
        .service('boards')
        .get(coerceString(args.boardId)!, ctx.baseServiceParams);
      let zoneData: ZoneBoardObject | undefined;
      const zoneId = coerceString(args.zoneId);
      if (zoneId) {
        const zone = board.objects?.[zoneId];
        if (zone?.type !== 'zone')
          throw new Error(`Zone ${zoneId} not found on board ${board.board_id}`);
        zoneData = zone;
      }

      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const { card, boardObject } = await runWithMcpTenantDatabaseScope(ctx, () =>
        cardsService.createWithPlacement(
          {
            board_id: board.board_id,
            title,
            card_type_id: coerceString(args.cardTypeId) as never,
            url: coerceString(args.url),
            description: coerceString(args.description),
            note: coerceString(args.note),
            data:
              args.data && typeof args.data === 'object'
                ? (args.data as Record<string, unknown>)
                : undefined,
            color_override: colorOverride ?? undefined,
            emoji_override: coerceString(args.emojiOverride),
            zoneId,
            zoneData,
          } as never,
          ctx.baseServiceParams
        )
      );

      emitServiceEvent(ctx.app, {
        path: 'cards',
        event: 'created',
        data: card,
      });
      emitServiceEvent(ctx.app, {
        path: 'board-objects',
        event: 'created',
        data: boardObject,
      });
      return textResult({ card, boardObject });
    }
  );

  // Tool 2: agor_cards_get
  server.registerTool(
    'agor_cards_get',
    {
      description: 'Get detailed information about a specific card, including its card type.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        cardId: mcpRequiredId('cardId', 'Card'),
      }),
    },
    async (args) => {
      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      // getWithType() reads the card repository over `this.db` directly and is
      // not a Feathers transport method, so enter the tenant DB scope here (the
      // other cards custom-method calls in this file do the same).
      const cardWithType = await runWithMcpTenantDatabaseScope(ctx, () =>
        cardsService.getWithType(args.cardId, ctx.baseServiceParams)
      );
      if (!cardWithType) throw new Error(`Card ${args.cardId} not found`);
      return textResult(cardWithType);
    }
  );

  // Tool 3: agor_cards_list
  server.registerTool(
    'agor_cards_list',
    {
      description:
        'List a page of cards with optional filtering by board, card type, zone, or search query. Archived cards are hidden unless includeArchived is true (or archived:true lists only archived cards). Advance with offset=nextOffset while hasMore is true.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        boardId: mcpOptionalId('boardId', 'Board', 'Filter by board ID'),
        cardTypeId: mcpOptionalId('cardTypeId', 'Card type', 'Filter by card type ID'),
        zoneId: mcpOptionalId('zoneId', 'Zone', 'Filter by zone ID (requires boardId)'),
        search: mcpOptionalString('search', 'Search query for card titles/descriptions'),
        archived: z
          .boolean()
          .optional()
          .describe(
            'Exact archive state to list: true lists only archived cards, false only active ones. Takes precedence over includeArchived.'
          ),
        includeArchived: z
          .boolean()
          .optional()
          .describe('Include archived cards alongside active ones (default false).'),
        limit: mcpLimit(50, 100),
        offset: mcpOffset(0),
      }),
    },
    async (args) => {
      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const boardIdRaw = coerceString(args.boardId);
      const boardId = boardIdRaw ? await resolveBoardId(ctx, boardIdRaw) : undefined;
      const cardTypeId = coerceString(args.cardTypeId);
      const zoneId = coerceString(args.zoneId);
      const search = coerceString(args.search);
      // Default: active cards only. `archived` pins an exact state; otherwise
      // includeArchived drops the archive predicate so both states are listed.
      const archived =
        typeof args.archived === 'boolean'
          ? args.archived
          : args.includeArchived === true
            ? undefined
            : false;
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      const offset = typeof args.offset === 'number' ? args.offset : 0;

      const query: Record<string, unknown> = {
        $limit: limit,
        $skip: offset,
        $sort: { created_at: -1, card_id: 1 },
      };
      if (archived !== undefined) query.archived = archived;
      if (boardId) query.board_id = boardId;
      if (cardTypeId) query.card_type_id = cardTypeId;
      if (zoneId) query.zone_id = zoneId;
      if (search) query.search = search;

      const result = await cardsService.find({ query, ...ctx.baseServiceParams } as never);
      return textResult(mcpPageResult<Card>(result, limit, offset));
    }
  );

  // Tool 4: agor_cards_update
  server.registerTool(
    'agor_cards_update',
    {
      description:
        "Update a card's metadata, or archive/unarchive it with archived. Archive finished cards (archived:true) instead of deleting them; use agor_cards_archive for removeFromBoard.",
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        cardId: mcpRequiredId('cardId', 'Card', 'Card ID to update'),
        title: mcpOptionalString('title', 'New title'),
        url: mcpOptionalString('url', 'New URL (null to clear)').nullable(),
        description: mcpOptionalString('description', 'New description (null to clear)').nullable(),
        note: mcpOptionalString('note', 'New note (null to clear)').nullable(),
        data: z
          .object({})
          .passthrough()
          .nullable()
          .optional()
          .describe('New data object (null to clear)'),
        colorOverride: mcpOptionalString(
          'colorOverride',
          `${CARD_COLOR_OVERRIDE_DESCRIPTION} Pass null to clear.`
        ).nullable(),
        emojiOverride: mcpOptionalString(
          'emojiOverride',
          'New emoji override (null to clear)'
        ).nullable(),
        archived: z.boolean().optional().describe(ARCHIVED_UPDATE_DESCRIPTION),
      }),
    },
    async (args) => {
      const updateData = cardPatchData(args as Parameters<typeof cardPatchData>[0]);
      if (args.colorOverride !== undefined)
        updateData.color_override = parseEntityColorOverride(args.colorOverride);
      const updatedCard = await applyCardUpdate(ctx, args.cardId, updateData, args.archived);
      return textResult(updatedCard);
    }
  );

  // Tool 5: agor_cards_delete
  server.registerTool(
    'agor_cards_delete',
    {
      description:
        'Permanently delete a card and its board placement. Cannot be undone. For finished or stale cards, prefer agor_cards_archive, which hides the card but keeps it restorable.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        cardId: mcpRequiredId('cardId', 'Card', 'Card ID to delete'),
      }),
    },
    async (args) => {
      await ctx.app.service('cards').remove(args.cardId, ctx.baseServiceParams);
      return textResult({ success: true, cardId: args.cardId });
    }
  );

  // Tool 6: agor_cards_archive
  server.registerTool(
    'agor_cards_archive',
    {
      description:
        'Archive a card: hide it from the board while keeping its data, reversible with agor_cards_unarchive. Preferred over agor_cards_delete for finished cards (e.g. cards left in a Done zone). removeFromBoard also deletes its board placement; unarchive re-places it.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        cardId: mcpRequiredId('cardId', 'Card', 'Card ID to archive'),
        removeFromBoard: z
          .boolean()
          .optional()
          .describe(
            "Also remove the card's board placement (zone and position). Default false keeps it so unarchive restores the card where it was."
          ),
      }),
    },
    async (args) => {
      const { card, removedBoardObject } = await applyCardArchiveChange(ctx, args.cardId, true, {
        removeFromBoard: args.removeFromBoard === true,
      });
      return textResult({
        ...card,
        removedBoardObjectId: removedBoardObject?.object_id ?? null,
      });
    }
  );

  // Tool 7: agor_cards_unarchive
  server.registerTool(
    'agor_cards_unarchive',
    {
      description:
        'Restore an archived card to its board. If its placement was removed when archived, it is re-placed at the default board position (move it with agor_cards_move or agor_cards_set_position).',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        cardId: mcpRequiredId('cardId', 'Card', 'Card ID to unarchive'),
        restorePlacement: z
          .boolean()
          .optional()
          .describe(
            'Re-place the card on its board when it has no placement (default true). False leaves it unplaced.'
          ),
      }),
    },
    async (args) => {
      const { card, createdBoardObject } = await applyCardArchiveChange(ctx, args.cardId, false, {
        restorePlacement: args.restorePlacement,
      });
      return textResult({ ...card, createdBoardObject: createdBoardObject ?? null });
    }
  );

  // Tool 8: agor_cards_move
  server.registerTool(
    'agor_cards_move',
    {
      description:
        'Move a card to a different zone (or unpin from zone). Updates board_objects placement.',
      inputSchema: z.object({
        cardId: mcpRequiredId('cardId', 'Card', 'Card ID to move'),
        zoneId: mcpOptionalId(
          'zoneId',
          'Zone',
          'Target zone ID (null to unpin from zone)'
        ).nullable(),
      }),
    },
    async (args) => {
      const cardId = await resolveCardId(ctx, args.cardId);
      const zoneId = args.zoneId === null ? null : (coerceString(args.zoneId) ?? null);
      const card = await ctx.app.service('cards').get(cardId, ctx.baseServiceParams);
      let zoneData: ZoneBoardObject | undefined;
      if (zoneId) {
        const board = await ctx.app.service('boards').get(card.board_id, ctx.baseServiceParams);
        const zone = board.objects?.[zoneId];
        if (zone?.type !== 'zone')
          throw new Error(`Zone ${zoneId} not found on board ${card.board_id}`);
        zoneData = zone;
      }
      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const boardObject = await runWithMcpTenantDatabaseScope(ctx, () =>
        cardsService.moveToZone(cardId as never, zoneId, zoneData, ctx.baseServiceParams)
      );
      emitServiceEvent(ctx.app, {
        path: 'board-objects',
        event: 'patched',
        data: boardObject,
      });
      return textResult(boardObject);
    }
  );

  // Tool 9: agor_cards_set_position
  server.registerTool(
    'agor_cards_set_position',
    {
      description: 'Set the exact position of a card on its board.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        cardId: mcpRequiredId('cardId', 'Card', 'Card ID to reposition'),
        x: mcpRequiredNumber('x', 'X coordinate'),
        y: mcpRequiredNumber('y', 'Y coordinate'),
      }),
    },
    async (args) => {
      const cardId = await resolveCardId(ctx, args.cardId);
      const boardObj = await runWithMcpTenantDatabaseScope(ctx, (db) =>
        new BoardObjectRepository(db).findByCardId(cardId as never)
      );
      if (!boardObj) throw new Error(`Card ${cardId} has no board placement`);
      // The transport patch carries the board-object Board Editor check and publishes the move.
      const updatedBoardObject = await ctx.app
        .service('board-objects')
        .patch(boardObj.object_id, { position: { x: args.x, y: args.y } }, ctx.baseServiceParams);
      return textResult(updatedBoardObject);
    }
  );

  // Tool 10: agor_cards_bulk_create
  server.registerTool(
    'agor_cards_bulk_create',
    {
      description:
        'Create multiple cards on a board in one operation. Each card gets its own board placement.',
      inputSchema: z.object({
        boardId: mcpRequiredId('boardId', 'Board', 'Board ID where cards will be created'),
        cards: z
          .array(
            z.object({
              title: mcpRequiredString('cards[].title', 'Card title'),
              cardTypeId: mcpOptionalId('cards[].cardTypeId', 'Card type', 'Card type ID'),
              zoneId: mcpOptionalId('cards[].zoneId', 'Zone', 'Zone ID to place the card in'),
              url: mcpOptionalString('cards[].url', 'URL'),
              description: mcpOptionalString('cards[].description', 'Description'),
              note: mcpOptionalString('cards[].note', 'Note'),
              data: z.object({}).passthrough().optional().describe('Custom data'),
              colorOverride: mcpOptionalString(
                'cards[].colorOverride',
                CARD_COLOR_OVERRIDE_DESCRIPTION
              ),
              emojiOverride: mcpOptionalString('cards[].emojiOverride', 'Emoji override'),
            })
          )
          .min(1, 'cards must contain at least one card.')
          .describe('Array of cards to create'),
      }),
    },
    async (args) => {
      const cardsArr = args.cards;
      if (!Array.isArray(cardsArr) || cardsArr.length === 0)
        throw new Error('non-empty cards array is required');
      // Validate every color before the first write so one bad entry never
      // leaves a partially created batch.
      const colorOverrides = cardsArr.map((c, index) =>
        parseEntityColorOverride(c.colorOverride, `cards[${index}].colorOverride`)
      );

      // Preserve the same short-ID resolution and authorization boundary while
      // avoiding resolveBoardId() + boards.get() for the same entity.
      const board = await ctx.app
        .service('boards')
        .get(coerceString(args.boardId)!, ctx.baseServiceParams);
      const cardsService = ctx.app.service('cards') as unknown as CardsService;

      const results = [];
      for (const [index, c] of cardsArr.entries()) {
        let zoneData: ZoneBoardObject | undefined;
        const zoneId = coerceString(c.zoneId);
        if (zoneId) {
          const zone = board.objects?.[zoneId];
          if (zone?.type === 'zone') zoneData = zone;
        }

        const { card, boardObject } = await runWithMcpTenantDatabaseScope(ctx, () =>
          cardsService.createWithPlacement(
            {
              board_id: board.board_id,
              title: c.title,
              card_type_id: coerceString(c.cardTypeId) as never,
              url: coerceString(c.url),
              description: coerceString(c.description),
              note: coerceString(c.note),
              data: c.data && typeof c.data === 'object' ? c.data : undefined,
              color_override: colorOverrides[index] ?? undefined,
              emoji_override: coerceString(c.emojiOverride),
              zoneId,
              zoneData,
            },
            ctx.baseServiceParams
          )
        );
        results.push(card);
        emitServiceEvent(ctx.app, {
          path: 'cards',
          event: 'created',
          data: card,
        });
        emitServiceEvent(ctx.app, {
          path: 'board-objects',
          event: 'created',
          data: boardObject,
        });
      }

      return textResult({ created: results.length, cards: results });
    }
  );

  // Tool 11: agor_cards_bulk_update
  server.registerTool(
    'agor_cards_bulk_update',
    {
      description:
        'Update multiple cards in one operation, including archiving finished cards with archived:true.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        updates: z
          .array(
            z.object({
              cardId: mcpRequiredId('updates[].cardId', 'Card', 'Card ID to update'),
              title: mcpOptionalString('updates[].title', 'New title'),
              url: mcpOptionalString('updates[].url', 'New URL').nullable(),
              description: mcpOptionalString('updates[].description', 'New description').nullable(),
              note: mcpOptionalString('updates[].note', 'New note').nullable(),
              data: z.object({}).passthrough().nullable().optional().describe('New data'),
              colorOverride: mcpOptionalString(
                'updates[].colorOverride',
                `${CARD_COLOR_OVERRIDE_DESCRIPTION} Pass null to clear.`
              ).nullable(),
              emojiOverride: mcpOptionalString(
                'updates[].emojiOverride',
                'New emoji override'
              ).nullable(),
              archived: z.boolean().optional().describe(ARCHIVED_UPDATE_DESCRIPTION),
            })
          )
          .min(1, 'updates must contain at least one update.')
          .describe('Array of card updates'),
      }),
    },
    async (args) => {
      const updates = args.updates;
      if (!Array.isArray(updates) || updates.length === 0)
        throw new Error('non-empty updates array is required');
      const colorOverrides = updates.map((u, index) =>
        u.colorOverride === undefined
          ? undefined
          : parseEntityColorOverride(u.colorOverride, `updates[${index}].colorOverride`)
      );

      const results = [];
      for (const [index, u] of updates.entries()) {
        const cardId = coerceString(u.cardId);
        if (!cardId) continue;
        const updateData = cardPatchData(u as Parameters<typeof cardPatchData>[0]);
        if (colorOverrides[index] !== undefined) updateData.color_override = colorOverrides[index];
        results.push(await applyCardUpdate(ctx, cardId, updateData, u.archived));
      }

      return textResult({ updated: results.length, cards: results });
    }
  );

  // Tool 12: agor_cards_bulk_move
  server.registerTool(
    'agor_cards_bulk_move',
    {
      description: 'Move multiple cards to different zones in one operation.',
      inputSchema: z.object({
        moves: z
          .array(
            z.object({
              cardId: mcpRequiredId('moves[].cardId', 'Card', 'Card ID to move'),
              zoneId: mcpOptionalId(
                'moves[].zoneId',
                'Zone',
                'Target zone ID (null to unpin)'
              ).nullable(),
            })
          )
          .min(1, 'moves must contain at least one move.')
          .describe('Array of card moves'),
      }),
    },
    async (args) => {
      const moves = args.moves;
      if (!Array.isArray(moves) || moves.length === 0)
        throw new Error('non-empty moves array is required');

      const cardsService = ctx.app.service('cards') as unknown as CardsService;
      const results = [];

      for (const m of moves) {
        const cardIdRaw = coerceString(m.cardId);
        if (!cardIdRaw) continue;
        const cardId = await resolveCardId(ctx, cardIdRaw);
        const zoneId = m.zoneId === null ? null : (coerceString(m.zoneId) ?? null);
        let zoneData: ZoneBoardObject | undefined;
        if (zoneId) {
          const card = await ctx.app.service('cards').get(cardId, ctx.baseServiceParams);
          const board = await ctx.app.service('boards').get(card.board_id, ctx.baseServiceParams);
          const zone = board.objects?.[zoneId];
          if (zone?.type === 'zone') zoneData = zone;
        }
        const boardObject = await runWithMcpTenantDatabaseScope(ctx, () =>
          cardsService.moveToZone(cardId as never, zoneId, zoneData, ctx.baseServiceParams)
        );
        emitServiceEvent(ctx.app, {
          path: 'board-objects',
          event: 'patched',
          data: boardObject,
        });
        results.push({ cardId, boardObject });
      }

      return textResult({ moved: results.length, results });
    }
  );
}
