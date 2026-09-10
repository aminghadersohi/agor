import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Database } from './client';
import { isPostgresDatabase, rawRows } from './database-wrapper';
import { AppVariableRepository } from './repositories/app-variables';
import * as schema from './schema.postgres';
import {
  getCurrentTenantDatabaseScope,
  requireCurrentTenantId,
  runWithTenantContext,
} from './tenant-scope';

// Two-key advisory lock family; tenant hash collisions only cause safe refusal.
export const STANDALONE_POWER_OWNER_LOCK_FAMILY = 0x41475057;
export const STANDALONE_POWER_OWNER_NAMESPACE = 'standalone_power_owner';
export const STANDALONE_POWER_OWNER_KEY = 'binding';
interface Binding {
  version: 1;
  host: string;
  boot: string;
  pid: number;
  backendStarted: string;
}

export class StandalonePowerOwnershipError extends Error {
  constructor() {
    super(
      'Standalone PostgreSQL ownership unavailable. New admissions and policy changes are blocked, including Off. Stop competing daemons and restart only on the bound host.'
    );
    this.name = 'StandalonePowerOwnershipError';
  }
}

function parseBinding(raw: string | null): Binding | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Binding;
    if (
      value.version !== 1 ||
      typeof value.host !== 'string' ||
      typeof value.boot !== 'string' ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.backendStarted !== 'string'
    ) {
      throw new StandalonePowerOwnershipError();
    }
    return value;
  } catch {
    // Never expose a malformed private binding in a parser or database error.
    throw new StandalonePowerOwnershipError();
  }
}

/**
 * One dedicated, reserved backend holds a SHARED session advisory lock. Acquisition
 * needs the EXCLUSIVE lock, so it cannot replace an owner or overtake an admission.
 * Each actual admission transaction takes a SHARED transaction lock and validates
 * the durable boot binding AND the dedicated backend's still-granted session lock.
 * The admission's lock survives owner disconnect until commit/rollback. Replacement
 * cannot pass it. No lease, timer, pool checkout, or process-local mutex is authority.
 *
 * Binding is tenant-owned (forced RLS app_variables); the hashed host identity is
 * operator-provisioned and must never be copied to another machine. Boot/PID/host
 * are private, not telemetry. Disconnect is fail-closed; this object never reacquires.
 */
export class StandalonePowerOwner {
  private lost = false;
  private constructor(
    private readonly client: ReturnType<typeof postgres>,
    private readonly connection: Awaited<ReturnType<ReturnType<typeof postgres>['reserve']>>,
    readonly tenantId: string,
    private readonly binding: Binding
  ) {}

  get status(): 'owned' | 'lost' {
    return this.lost ? 'lost' : 'owned';
  }

  static async acquire(
    url: string,
    tenantId: string,
    hostId: string
  ): Promise<StandalonePowerOwner> {
    const client = postgres(url, {
      max: 1,
      idle_timeout: 0,
      max_lifetime: 0,
      prepare: false,
      connection: { statement_timeout: 10000, idle_in_transaction_session_timeout: 15000 },
    });
    try {
      const connection = await client.reserve();
      const [role] =
        await connection`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      if (role.rolsuper || role.rolbypassrls) throw new StandalonePowerOwnershipError();
      await connection`BEGIN`;
      await connection`SELECT set_config('agor.tenant_id', ${tenantId}, true)`;
      const [lock] =
        await connection`SELECT pg_try_advisory_lock(${STANDALONE_POWER_OWNER_LOCK_FAMILY}, hashtext(${tenantId})) AS acquired, pg_backend_pid() AS pid,
        (SELECT backend_start::text FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS started`;
      if (!lock.acquired || typeof lock.started !== 'string')
        throw new StandalonePowerOwnershipError();
      // postgres.js ReservedSql omits options; Drizzle needs the parent type codecs.
      // Queries still execute exclusively through the reserved backend, never the pool.
      const db = drizzle(Object.assign(connection, { options: client.options }), { schema });
      const repository = new AppVariableRepository(db as Database);
      const owner = await runWithTenantContext(tenantId, async () => {
        const previous = parseBinding(
          await repository.getPlain(STANDALONE_POWER_OWNER_NAMESPACE, STANDALONE_POWER_OWNER_KEY)
        );
        const host = createHash('sha256').update(hostId.toLowerCase()).digest('hex');
        if (previous && previous.host !== host) throw new StandalonePowerOwnershipError();
        const binding: Binding = {
          version: 1,
          host,
          boot: randomUUID(),
          pid: Number(lock.pid),
          backendStarted: String(lock.started),
        };
        await repository.set({
          namespace: STANDALONE_POWER_OWNER_NAMESPACE,
          key: STANDALONE_POWER_OWNER_KEY,
          value: JSON.stringify(binding),
          content_type: 'application/json',
        });
        await connection`SELECT pg_advisory_lock_shared(${STANDALONE_POWER_OWNER_LOCK_FAMILY}, hashtext(${tenantId}))`;
        await connection`COMMIT`;
        await connection`SELECT pg_advisory_unlock(${STANDALONE_POWER_OWNER_LOCK_FAMILY}, hashtext(${tenantId}))`;
        return new StandalonePowerOwner(client, connection, tenantId, binding);
      });
      return owner;
    } catch {
      await client.end({ timeout: 0 });
      throw new StandalonePowerOwnershipError();
    }
  }

  stopAdmissions(): void {
    this.lost = true;
  }

  /** Close only the authority connection, never an executor or a Task. No auto-reacquire. */
  async close(): Promise<void> {
    this.lost = true;
    await this.client.end({ timeout: 0 });
  }

  /** Read-only liveness refresh for the UI. Actual admission never trusts this cache. */
  async refresh(): Promise<void> {
    if (this.lost) return;
    try {
      const [row] = await this.connection`SELECT pg_backend_pid() AS pid`;
      if (Number(row.pid) !== this.binding.pid) this.lost = true;
    } catch {
      this.lost = true;
    }
  }

  static async assertAdmission(db: Database, owner?: StandalonePowerOwner): Promise<void> {
    if (!isPostgresDatabase(db)) return;
    const tenantId = requireCurrentTenantId();
    // Never permit a check whose lock disappears before the actual mutation.
    const scope = getCurrentTenantDatabaseScope();
    if (scope?.kind !== 'tenant' || !scope.transactionActive)
      throw new StandalonePowerOwnershipError();
    db = scope.db; // Bind the lock to the actual tenant transaction, never another pool checkout.
    if (!isPostgresDatabase(db)) throw new StandalonePowerOwnershipError();
    await db.execute(
      sql`SELECT pg_advisory_xact_lock_shared(${STANDALONE_POWER_OWNER_LOCK_FAMILY}, hashtext(${tenantId}))`
    );
    const binding = parseBinding(
      await new AppVariableRepository(db).getPlain(
        STANDALONE_POWER_OWNER_NAMESPACE,
        STANDALONE_POWER_OWNER_KEY
      )
    );
    if (!binding && !owner) return; // Explicitly unbound existing PostgreSQL topology.
    if (
      !binding ||
      !owner ||
      owner.lost ||
      owner.tenantId !== tenantId ||
      binding.boot !== owner.binding.boot ||
      binding.pid !== owner.binding.pid ||
      binding.backendStarted !== owner.binding.backendStarted ||
      binding.host !== owner.binding.host
    ) {
      throw new StandalonePowerOwnershipError();
    }
    const rows = rawRows<{ alive: boolean }>(
      await db.execute(sql`
      SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid = ${STANDALONE_POWER_OWNER_LOCK_FAMILY}::oid AND objid = (hashtext(${tenantId})::bigint & 4294967295)::oid
          AND objsubid = 2 AND mode = 'ShareLock' AND granted AND l.pid = ${binding.pid}
          AND a.backend_start = ${binding.backendStarted}::timestamptz) AS alive`)
    );
    if (rows[0]?.alive !== true) {
      owner.lost = true;
      throw new StandalonePowerOwnershipError();
    }
  }
}
