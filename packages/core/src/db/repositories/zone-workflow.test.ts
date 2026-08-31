import type { BoardID, CardID, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { ownedDbTest as dbTest } from '../test-helpers';
import { RepositoryError } from './base';
import { BoardObjectRepository } from './board-objects';
import { BoardRepository } from './boards';
import { CardRepository } from './cards';
import { ZoneWorkflowRepository } from './zone-workflow';

describe('ZoneWorkflowRepository', () => {
  dbTest(
    'atomically advances a positioned card and replays its audit without moving twice',
    async ({ db }) => {
      const boardId = generateId() as BoardID;
      await new BoardRepository(db).create({
        board_id: boardId,
        name: 'Workflow board',
        created_by: 'test-user',
        objects: {
          todo: { type: 'zone', x: 0, y: 0, width: 400, height: 300, label: 'Todo' },
          done: { type: 'zone', x: 500, y: 0, width: 300, height: 200, label: 'Done' },
        },
      });
      const card = await new CardRepository(db).create({ board_id: boardId, title: 'Ship it' });
      const placement = await new BoardObjectRepository(db).create({
        board_id: boardId,
        card_id: card.card_id as CardID,
        position: { x: 350, y: 250 },
        zone_id: 'todo',
      });
      const repo = new ZoneWorkflowRepository(db);
      const transition = await repo.createTransition(
        {
          board_id: boardId,
          source_zone_id: 'todo',
          target_zone_id: 'done',
          label: 'Complete',
        },
        'test-user' as UUID
      );
      await expect(
        repo.createTransition(
          {
            board_id: boardId,
            source_zone_id: 'todo',
            target_zone_id: 'done',
            label: 'Duplicate',
          },
          'test-user' as UUID
        )
      ).rejects.toThrow(RepositoryError);

      const idempotencyKey = generateId() as UUID;
      const first = await repo.advance({
        transitionId: transition.transition_id,
        idempotencyKey,
        entities: [{ entity_type: 'card', entity_id: card.card_id as CardID }],
        requestedBy: 'test-user' as UUID,
      });
      expect(first.replayed).toBe(false);
      expect(first.moved).toEqual([
        expect.objectContaining({
          object_id: placement.object_id,
          zone_id: 'done',
          position: { x: 220, y: 140 },
        }),
      ]);
      expect(first.audit).toMatchObject({
        transition_id: transition.transition_id,
        idempotency_key: idempotencyKey,
        prompt_outcome: 'not_requested',
      });

      const replay = await repo.advance({
        transitionId: transition.transition_id,
        idempotencyKey,
        entities: [{ entity_type: 'card', entity_id: card.card_id as CardID }],
        requestedBy: 'test-user' as UUID,
      });
      expect(replay).toMatchObject({ replayed: true, moved: [] });
      expect(replay.audit.advance_id).toBe(first.audit.advance_id);
      await expect(repo.findAdvances(boardId)).resolves.toHaveLength(1);
    }
  );
});
