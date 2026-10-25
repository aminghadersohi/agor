import { sql } from 'drizzle-orm';
import type { Database } from './client';
import { executeRaw } from './database-wrapper';

/**
 * Undo upstream's Teams gateway HA and failed-deletion discovery migrations on
 * a fully migrated SQLite database. Fork tests that rewind the ledger below the
 * fork's band replay them, and their plain ADD COLUMN / CREATE INDEX statements
 * (SQLite cannot add either conditionally) need those objects gone first.
 */
export async function dropTeamsAndDeletionDiscoveryObjects(db: Database): Promise<void> {
  for (const index of [
    'branches_deletion_process_discovery_idx',
    'gateway_channels_teams_installation_unique',
    'gateway_inbound_events_teams_due_idx',
    'gateway_inbound_events_teams_lane_idx',
    'gateway_inbound_events_teams_expiry_idx',
  ]) {
    await executeRaw(db, sql.raw(`DROP INDEX IF EXISTS ${index}`));
  }
  await executeRaw(db, sql`DROP TABLE teams_message_deliveries`);
  await executeRaw(db, sql`DROP TABLE teams_conversation_addresses`);
  for (const column of [
    'payload_encrypted',
    'payload_expires_at',
    'provider_config_generation',
    'verified_app_id',
    'verified_tenant_id',
    'attempt_count',
    'next_attempt_at',
    'last_error_code',
  ]) {
    await executeRaw(db, sql.raw(`ALTER TABLE gateway_inbound_events DROP COLUMN ${column}`));
  }
  await executeRaw(
    db,
    sql`ALTER TABLE thread_session_map DROP COLUMN teams_last_admitted_activity_id`
  );
}

/**
 * PostgreSQL twin of {@link dropTeamsAndDeletionDiscoveryObjects}. The PG
 * migrations also add tenant-leading unique indexes, discovery policies and
 * RLS-bound tables; dropping the two Teams tables removes their own indexes,
 * policies and foreign keys before the channel index they reference.
 */
export async function dropTeamsAndDeletionDiscoveryObjectsPostgres(db: Database): Promise<void> {
  await executeRaw(db, sql`DROP INDEX IF EXISTS branches_deletion_process_discovery_idx`);
  await executeRaw(db, sql`DROP TABLE teams_message_deliveries`);
  await executeRaw(db, sql`DROP TABLE teams_conversation_addresses`);
  await executeRaw(
    db,
    sql`DROP POLICY IF EXISTS "teams_gateway_inbound_discovery" ON gateway_inbound_events`
  );
  await executeRaw(
    db,
    sql`DROP POLICY IF EXISTS "teams_gateway_ingress_discovery" ON gateway_channels`
  );
  for (const index of [
    'gateway_inbound_events_teams_due_idx',
    'gateway_inbound_events_teams_lane_idx',
    'gateway_inbound_events_teams_expiry_idx',
    'gateway_channels_teams_installation_unique',
    'gateway_channels_tenant_id_unique',
  ]) {
    await executeRaw(db, sql.raw(`DROP INDEX IF EXISTS ${index}`));
  }
  for (const column of [
    'payload_encrypted',
    'payload_expires_at',
    'provider_config_generation',
    'verified_app_id',
    'verified_tenant_id',
    'attempt_count',
    'next_attempt_at',
    'last_error_code',
  ]) {
    await executeRaw(db, sql.raw(`ALTER TABLE gateway_inbound_events DROP COLUMN ${column}`));
  }
  await executeRaw(
    db,
    sql`ALTER TABLE thread_session_map DROP COLUMN teams_last_admitted_activity_id`
  );
}
