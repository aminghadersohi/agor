/**
 * CardsService Tests
 *
 * Verifies the SQL pushdown on CardsService.find: board_id + archived predicates
 * reach the repository read while results stay identical to the in-memory path.
 */

import { BoardRepository, CardRepository, type Database, generateId } from '@agor/core/db';
import type { BoardID, Card, CardID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { ownedDbTest as dbTest } from '../../../../packages/core/src/db/test-helpers';
import { seedBoardEntities } from '../../test/board-entity-fixture';
import { type CardParams, CardsService } from './cards';

async function seed(db: Database) {
  const boardRepo = new BoardRepository(db);
  const cardRepo = new CardRepository(db);
  const boardA = (
    await boardRepo.create({ board_id: generateId(), name: 'A', created_by: 'test-user' })
  ).board_id as BoardID;
  const boardB = (
    await boardRepo.create({ board_id: generateId(), name: 'B', created_by: 'test-user' })
  ).board_id as BoardID;

  const a1 = await cardRepo.create({ board_id: boardA, title: 'beta' });
  const a2 = await cardRepo.create({ board_id: boardA, title: 'alpha' });
  const aArchived = await cardRepo.create({ board_id: boardA, title: 'gamma' });
  await cardRepo.archive(aArchived.card_id);
  await cardRepo.create({ board_id: boardB, title: 'other' });

  const service = new CardsService(db);
  return { service, boardA, boardB, a1, a2, aArchived };
}

describe('CardsService.find SQL pushdown', () => {
  dbTest('pushes board_id into the repository read', async ({ db }) => {
    const { service, boardA } = await seed(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { cardRepo: CardRepository }).cardRepo,
      'findAll'
    );

    const result = (await service.find({ query: { board_id: boardA } })) as {
      data: Card[];
      total: number;
    };

    // SQL-bounded: the board predicate reaches the repository, not a whole-table read.
    expect(repoFindAll).toHaveBeenCalledWith({ board_id: boardA });
    // boardA has 3 cards (2 active + 1 archived).
    expect(result.total).toBe(3);
    expect(result.data.every((c) => c.board_id === boardA)).toBe(true);
  });

  dbTest('pushes board_id + archived and preserves sort/total parity', async ({ db }) => {
    const { service, boardA } = await seed(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { cardRepo: CardRepository }).cardRepo,
      'findAll'
    );

    const result = (await service.find({
      query: { board_id: boardA, archived: false, $sort: { title: 1 } },
    })) as { data: Card[]; total: number };

    expect(repoFindAll).toHaveBeenCalledWith({ board_id: boardA, archived: false });
    expect(result.total).toBe(2);
    expect(result.data.map((c) => c.title)).toEqual(['alpha', 'beta']);
  });

  dbTest('leaves an uncoerced string archived to the in-memory filter', async ({ db }) => {
    const { service, boardA } = await seed(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { cardRepo: CardRepository }).cardRepo,
      'findAll'
    );

    // Cards are not query-validated; a raw string 'false' must NOT be pushed as a
    // boolean. The repository read carries only board_id; the string predicate
    // falls through to the in-memory equality filter exactly as before (no card
    // row has archived === 'false', so the result is empty).
    const result = (await service.find({
      query: { board_id: boardA, archived: 'false' as unknown as boolean },
    })) as { data: Card[]; total: number };

    expect(repoFindAll).toHaveBeenCalledWith({ board_id: boardA });
    expect(result.total).toBe(0);
  });
});

describe('CardsService.moveToZone placement', () => {
  dbTest('does not drop the moved card onto the zone occupants', async ({ db }) => {
    const { BoardObjectRepository } = await import('@agor/core/db');
    const boardRepo = new BoardRepository(db);
    const cardRepo = new CardRepository(db);
    const objectRepo = new BoardObjectRepository(db);
    const board = (
      await boardRepo.create({ board_id: generateId(), name: 'Z', created_by: 'test-user' })
    ).board_id as BoardID;

    // Sized so the old jitter placement is deterministically wrong rather than
    // usually wrong: at 270px tall there is no vertical jitter range left, so
    // every blind placement lands at y=60 and every blind placement therefore
    // lands on the occupant below. The old behaviour was random, which is how
    // it survived review -- it only collided some of the time.
    const zone = { type: 'zone' as const, x: 0, y: 0, width: 620, height: 270 };

    const sitting = await cardRepo.create({ board_id: board, title: 'sitting' });
    const occupant = await objectRepo.create({
      board_id: board,
      card_id: sitting.card_id,
      position: { x: 24, y: 24 },
      size: { width: 400, height: 150 },
      zone_id: 'zone-1',
    });

    const moving = await cardRepo.create({ board_id: board, title: 'moving' });
    await objectRepo.create({
      board_id: board,
      card_id: moving.card_id,
      position: { x: 5000, y: 5000 },
    });

    const service = new CardsService(db);
    const placed = await service.moveToZone(moving.card_id, 'zone-1', zone);

    expect(placed.zone_id).toBe('zone-1');
    const moved = { ...placed.position, width: 400, height: 150 };
    const other = { ...occupant.position, width: 400, height: 150 };
    const overlaps =
      moved.x < other.x + other.width &&
      other.x < moved.x + moved.width &&
      moved.y < other.y + other.height &&
      other.y < moved.y + moved.height;
    expect(overlaps).toBe(false);
  });
});

describe('CardsService archive / unarchive', () => {
  async function seedPlaced(db: Database) {
    const { BoardObjectRepository } = await import('@agor/core/db');
    const fixture = await seedBoardEntities(db);
    const service = new CardsService(db);
    const objects = new BoardObjectRepository(db);
    const cardId = fixture.cardObject.card_id as CardID;
    const paramsFor = (user: { user_id: string; email: string; role: string }): CardParams => ({
      provider: 'rest',
      authenticated: true,
      user: { user_id: user.user_id, email: user.email, role: user.role } as never,
    });
    return { ...fixture, service, objects, cardId, paramsFor };
  }

  dbTest('archive keeps the placement unless removeFromBoard is set', async ({ db }) => {
    const { service, objects, cardId, owner, paramsFor } = await seedPlaced(db);

    const { card, removedBoardObject } = await service.archive(cardId, paramsFor(owner));
    expect(card.archived).toBe(true);
    expect(card.archived_at).toBeDefined();
    expect(removedBoardObject).toBeUndefined();
    expect(await objects.findByCardId(cardId)).not.toBeNull();
  });

  dbTest('removeFromBoard deletes the placement; unarchive re-places it', async ({ db }) => {
    const { service, objects, cardId, owner, board, cardObject, paramsFor } = await seedPlaced(db);
    const params = paramsFor(owner);

    const archived = await service.archive(cardId, params, { removeFromBoard: true });
    expect(archived.card.archived).toBe(true);
    expect(archived.removedBoardObject?.object_id).toBe(cardObject.object_id);
    expect(await objects.findByCardId(cardId)).toBeNull();

    // A retry is safe: the card stays archived with its first archive time.
    const again = await service.archive(cardId, params, { removeFromBoard: true });
    expect(again.card.archived_at).toBe(archived.card.archived_at);
    expect(again.removedBoardObject).toBeUndefined();

    const restored = await service.unarchive(cardId, params);
    expect(restored.card.archived).toBe(false);
    expect(restored.card.archived_at).toBeUndefined();
    expect(restored.createdBoardObject).toMatchObject({
      board_id: board.board_id,
      card_id: cardId,
      position: { x: 0, y: 0 },
    });
    expect((await objects.findByCardId(cardId))?.object_id).toBe(
      restored.createdBoardObject?.object_id
    );
  });

  dbTest('unarchive keeps an existing placement and can skip re-placement', async ({ db }) => {
    const { service, objects, cardId, owner, cardObject, paramsFor } = await seedPlaced(db);
    const params = paramsFor(owner);

    await service.archive(cardId, params);
    const kept = await service.unarchive(cardId, params);
    expect(kept.createdBoardObject).toBeUndefined();
    expect((await objects.findByCardId(cardId))?.object_id).toBe(cardObject.object_id);

    await service.archive(cardId, params, { removeFromBoard: true });
    const unplaced = await service.unarchive(cardId, params, { restorePlacement: false });
    expect(unplaced.card.archived).toBe(false);
    expect(unplaced.createdBoardObject).toBeUndefined();
    expect(await objects.findByCardId(cardId)).toBeNull();
  });

  dbTest('archive and unarchive need board mutate access', async ({ db }) => {
    const { service, objects, cardId, other, paramsFor } = await seedPlaced(db);
    const cards = new CardRepository(db);

    // `other` is a workspace member with no access to the private board.
    await expect(
      service.archive(cardId, paramsFor(other), { removeFromBoard: true })
    ).rejects.toThrow();
    expect((await cards.findById(cardId))?.archived).toBe(false);
    expect(await objects.findByCardId(cardId)).not.toBeNull();

    // A workspace viewer is below the Member floor for any card mutation.
    const viewer = { ...other, role: 'viewer' };
    await expect(service.archive(cardId, paramsFor(viewer))).rejects.toThrow(/member access/);

    await cards.archive(cardId);
    await expect(service.unarchive(cardId, paramsFor(other))).rejects.toThrow();
    expect((await cards.findById(cardId))?.archived).toBe(true);
  });

  dbTest('find hides nothing by itself: archived is an explicit filter', async ({ db }) => {
    const { service, cardId, board } = await seedPlaced(db);
    await new CardRepository(db).archive(cardId);
    const active = (await service.find({
      query: { board_id: board.board_id, archived: false },
    })) as { data: Card[] };
    const all = (await service.find({ query: { board_id: board.board_id } })) as {
      data: Card[];
    };
    expect(active.data.map((c) => c.card_id)).not.toContain(cardId);
    expect(all.data.map((c) => c.card_id)).toContain(cardId);
  });
});
