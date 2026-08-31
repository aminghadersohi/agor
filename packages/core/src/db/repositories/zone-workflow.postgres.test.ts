import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { BoardID, CardID, TenantID, UUID } from '../../types';
import { createDatabase, type Database } from '../client';
import { executeRaw } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BoardObjectRepository } from './board-objects';
import { BoardRepository } from './boards';
import { CardRepository } from './cards';
import { UsersRepository } from './users';
import { ZoneWorkflowRepository } from './zone-workflow';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const enabled = process.env.AGOR_DB_DIALECT === 'postgresql' && Boolean(postgresUrl);

function firstRow(result: unknown): Record<string, unknown> {
  if (Array.isArray(result)) return (result[0] ?? {}) as Record<string, unknown>;
  return ((result as { rows?: unknown[] }).rows?.[0] ?? {}) as Record<string, unknown>;
}

describe.skipIf(!enabled)('zone workflow fresh schema and PostgreSQL tenant RLS', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
    await initializeDatabase(db);
    const role = firstRow(
      await executeRaw(
        db,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      )
    );
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  afterAll(async () => {
    await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
  });

  async function seed(tenantId: TenantID) {
    return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
      const owner = await new UsersRepository(scoped).create({
        email: `workflow-${generateId()}@example.test`,
        role: 'member',
      });
      const board = await new BoardRepository(scoped).create({
        name: `Workflow ${tenantId}`,
        created_by: owner.user_id,
        objects: {
          source: { type: 'zone', x: 0, y: 0, width: 300, height: 200, label: 'Source' },
          target: { type: 'zone', x: 400, y: 0, width: 300, height: 200, label: 'Target' },
        },
      });
      const card = await new CardRepository(scoped).create({
        board_id: board.board_id,
        title: `Card ${tenantId}`,
      });
      await new BoardObjectRepository(scoped).create({
        board_id: board.board_id,
        card_id: card.card_id as CardID,
        position: { x: 20, y: 40 },
        zone_id: 'source',
      });
      const transition = await new ZoneWorkflowRepository(scoped).createTransition(
        {
          board_id: board.board_id as BoardID,
          source_zone_id: 'source',
          target_zone_id: 'target',
          label: 'Advance',
        },
        owner.user_id as UUID
      );
      return { owner, board, card, transition };
    });
  }

  it('isolates transitions and audits while allowing tenant-local idempotency keys', async () => {
    const tenantA = `zone-workflow-a-${generateId()}` as TenantID;
    const tenantB = `zone-workflow-b-${generateId()}` as TenantID;
    const [a, b] = await Promise.all([seed(tenantA), seed(tenantB)]);
    const sharedKey = generateId() as UUID;

    const auditA = await runWithTenantDatabaseScope(
      db,
      tenantA,
      async (scoped) =>
        (
          await new ZoneWorkflowRepository(scoped).advance({
            transitionId: a.transition.transition_id,
            idempotencyKey: sharedKey,
            entities: [{ entity_type: 'card', entity_id: a.card.card_id as CardID }],
            requestedBy: a.owner.user_id as UUID,
          })
        ).audit
    );
    const auditB = await runWithTenantDatabaseScope(
      db,
      tenantB,
      async (scoped) =>
        (
          await new ZoneWorkflowRepository(scoped).advance({
            transitionId: b.transition.transition_id,
            idempotencyKey: sharedKey,
            entities: [{ entity_type: 'card', entity_id: b.card.card_id as CardID }],
            requestedBy: b.owner.user_id as UUID,
          })
        ).audit
    );

    await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
      const repo = new ZoneWorkflowRepository(scoped);
      expect(await repo.findTransitions()).toEqual([a.transition]);
      expect(await repo.findTransition(b.transition.transition_id)).toBeNull();
      expect(await repo.findAdvance(auditB.advance_id)).toBeNull();
      expect(await repo.findAdvances()).toEqual([auditA]);
      await expect(
        repo.advance({
          transitionId: b.transition.transition_id,
          idempotencyKey: generateId() as UUID,
          entities: [{ entity_type: 'card', entity_id: a.card.card_id as CardID }],
          requestedBy: a.owner.user_id as UUID,
        })
      ).rejects.toThrow(/ZoneWorkflowTransition.*not found/);
    });
  });
});
