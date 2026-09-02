import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BoardObjectRepository,
  BoardRepository,
  CardRepository,
  createDatabase,
  generateId,
  initializeDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { BoardID, CardID, UUID } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZoneWorkflowAdvancesService, ZoneWorkflowTransitionsService } from './zone-workflow.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agor-zone-workflow-service-'));
  cleanup.push(dir);
  const db = createDatabase({ url: `file:${join(dir, 'test.db')}` });
  await initializeDatabase(db);
  const userId = generateId() as UUID;
  await new UsersRepository(db).create({
    user_id: userId,
    email: `${userId}@agor.test`,
    name: 'Workflow tester',
    role: 'member',
  });
  const boardId = generateId() as BoardID;
  await new BoardRepository(db).create({
    board_id: boardId,
    name: 'Workflow board',
    created_by: userId,
    objects: {
      source: { type: 'zone', x: 0, y: 0, width: 400, height: 300, label: 'Source' },
      target: { type: 'zone', x: 500, y: 0, width: 400, height: 300, label: 'Target' },
    },
  });
  const card = await new CardRepository(db).create({ board_id: boardId, title: 'Ready' });
  await new BoardObjectRepository(db).create({
    board_id: boardId,
    card_id: card.card_id as CardID,
    position: { x: 40, y: 50 },
    zone_id: 'source',
  });
  return { db, userId, boardId, card };
}

describe('zone workflow services', () => {
  it('validates real board zones, advances through the repository, and emits placement realtime', async () => {
    const { db, userId, boardId, card } = await fixture();
    const transitions = new ZoneWorkflowTransitionsService(db);
    const params = { user: { user_id: userId, role: 'member' } } as never;
    await expect(
      transitions.create(
        {
          board_id: boardId,
          source_zone_id: 'missing',
          target_zone_id: 'target',
          label: 'Invalid',
        },
        params
      )
    ).rejects.toThrow('source_zone_id must name a zone');
    await expect(
      transitions.create(
        {
          board_id: boardId,
          source_zone_id: 'source',
          target_zone_id: 'target',
          label: 'Invalid behavior',
          behavior: 'execute' as never,
        },
        params
      )
    ).rejects.toThrow('behavior must be guidance_only or target_zone_prompt');

    const transition = await transitions.create(
      {
        board_id: boardId,
        source_zone_id: 'source',
        target_zone_id: 'target',
        label: ' Advance ',
      },
      params
    );
    const emit = vi.fn();
    const app = { service: vi.fn(() => ({ emit })) } as unknown as Application;
    await expect(
      new ZoneWorkflowAdvancesService(db, app).create(
        {
          transition_id: transition.transition_id,
          idempotency_key: generateId() as UUID,
          entities: [{ entity_type: 'repo' as never, entity_id: card.card_id as CardID }],
        },
        params
      )
    ).rejects.toThrow('Every entity must have a valid entity_type');
    const audit = await new ZoneWorkflowAdvancesService(db, app).create(
      {
        transition_id: transition.transition_id,
        idempotency_key: generateId() as UUID,
        entities: [{ entity_type: 'card', entity_id: card.card_id as CardID }],
      },
      params
    );

    expect(transition.label).toBe('Advance');
    expect(audit.entities).toHaveLength(1);
    expect(emit).toHaveBeenCalledWith(
      'patched',
      expect.objectContaining({ card_id: card.card_id, zone_id: 'target' }),
      expect.objectContaining({ path: 'board-objects', method: 'patch' })
    );
  });
});
