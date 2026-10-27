import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { MaintenanceAdmissionLease, MaintenanceAdmissionStatus } from '../types';
import type { Database } from './client';
import {
  executeRaw,
  isPostgresDatabase,
  rawRows,
  runDatabaseTransaction,
} from './database-wrapper';
import {
  INSTALL_MAINTENANCE_ADMISSION_SQL,
  MAINTENANCE_POLICY,
  MAINTENANCE_TRIGGER_BODY,
} from './maintenance-admission-sql';
import {
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  runWithSystemDatabaseScope,
} from './tenant-scope';

export class MaintenanceAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceAdmissionError';
  }
}

const fail = (message: string): never => {
  throw new MaintenanceAdmissionError(message);
};
const rows = async <T extends Record<string, unknown>>(
  db: Database,
  query: Parameters<typeof executeRaw>[1]
) => rawRows<T>(await executeRaw(db, query));

/** Not exposed by REST, socket or MCP. DB-owner/operator CLI authority only. */
async function operator<T>(db: Database, work: (tx: Database) => Promise<T>): Promise<T> {
  if (getCurrentTenantId() || getCurrentTenantDatabaseScope())
    fail('Maintenance requires an explicit operator connection outside tenant context');
  if (!isPostgresDatabase(db)) fail('Maintenance admission requires PostgreSQL');
  return runWithSystemDatabaseScope(db, 'operator maintenance admission', async (systemDb) =>
    runDatabaseTransaction(systemDb, async (tx) => {
      await executeRaw(tx, sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
      await executeRaw(tx, sql`SET LOCAL lock_timeout = '3s'`);
      const [authority] = await rows<{ owner: boolean; tenant: string | null }>(
        tx,
        sql`
        SELECT current_user = pg_get_userbyid(relowner) AS owner,
          nullif(current_setting('agor.tenant_id', true), '') AS tenant
        FROM pg_class WHERE oid = 'public.tasks'::regclass`
      );
      if (!authority?.owner || authority.tenant)
        fail('Maintenance requires the database table owner, without tenant routing');
      return work(tx);
    })
  );
}

async function verifyInstallation(tx: Database): Promise<void> {
  const [proof] = await rows<{
    owner: boolean;
    body: string;
    version: number;
    triggers: number;
    policies: number;
  }>(
    tx,
    sql`
    SELECT n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owner,
      p.prosrc AS body, c.version,
      (SELECT count(*)::integer FROM pg_trigger t
        WHERE t.tgname = 'agor_maintenance_admission' AND NOT t.tgisinternal
          AND t.tgenabled IN ('O','A') AND t.tgfoid = p.oid
          AND ((t.tgrelid IN ('public.tasks'::regclass,'public.branches'::regclass) AND t.tgtype=23)
            OR (t.tgrelid='public.sessions'::regclass AND t.tgtype=7))) AS triggers,
      (SELECT count(*)::integer FROM pg_policy pol
        WHERE pol.polname = 'maintenance_admission_discovery' AND pol.polcmd = 'r'
          AND pol.polrelid IN ('public.tasks'::regclass,'public.branches'::regclass)
          AND pg_get_expr(pol.polqual,pol.polrelid) = ${MAINTENANCE_POLICY}) AS policies
    FROM pg_namespace n JOIN pg_proc p ON p.pronamespace = n.oid
      CROSS JOIN agor_maintenance.control c
    WHERE n.nspname = 'agor_maintenance' AND p.proname = 'admission' AND p.prosecdef
      AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND c.singleton`
  );
  if (
    !proof?.owner ||
    proof.body !== MAINTENANCE_TRIGGER_BODY ||
    proof.version !== 1 ||
    proof.triggers !== 3 ||
    proof.policies !== 2
  )
    fail('Maintenance installation is missing, changed or not owned by this operator');
}

/** Installation and acquisition commit together: no restart or prior daemon support required. */
export async function acquireMaintenanceAdmission(
  db: Database,
  options: { ttlMs: number; install?: boolean }
): Promise<MaintenanceAdmissionLease> {
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 60_000 || options.ttlMs > 14_400_000)
    fail('Maintenance lease must be between 60 seconds and 4 hours');
  return operator(db, async (tx) => {
    if (options.install) {
      const [exists] = await rows<{ present: boolean }>(
        tx,
        sql`SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'agor_maintenance') AS present`
      );
      if (!exists?.present) await executeRaw(tx, sql.raw(INSTALL_MAINTENANCE_ADMISSION_SQL));
    }
    await verifyInstallation(tx);
    const generation = randomUUID();
    // FOR UPDATE conflicts with every trigger's FOR SHARE until its admission
    // transaction commits. No check-then-act or process-local lock authority.
    const [held] = await rows<{ generation: string; expires_at: Date; database: string }>(
      tx,
      sql`
      UPDATE agor_maintenance.control SET phase='draining', generation=${generation},
        expires_at=date_trunc('milliseconds',clock_timestamp())+(${options.ttlMs} * interval '1 millisecond'), idle_since=NULL
      WHERE singleton AND phase='released'
      RETURNING generation, expires_at, current_database() AS database`
    );
    if (!held) fail('Maintenance is already held; inspect and release the exact generation first');
    await audit(tx, 'acquired', generation);
    return {
      database: held.database,
      generation,
      expiresAt: new Date(held.expires_at).toISOString(),
    };
  });
}

async function audit(tx: Database, event: string, generation: string): Promise<void> {
  await executeRaw(
    tx,
    sql`INSERT INTO agor_maintenance.audit(event,generation,operator_role) VALUES(${event},${generation},current_user)`
  );
}

async function status(tx: Database): Promise<MaintenanceAdmissionStatus> {
  // These policies expose aggregate-only operator observations. Tenant context
  // cannot reach this API; no tenant IDs/prompts/tool output are returned.
  await executeRaw(
    tx,
    sql`SELECT set_config('agor.system_scope','maintenance_admission_discovery',true)`
  );
  const [r] = await rows<{
    database: string;
    phase: MaintenanceAdmissionStatus['phase'];
    generation: string | null;
    expires_at: Date | null;
    observed_at: Date;
    expired: boolean;
    idle_since: Date | null;
    unfinished: number;
    restart: number;
    branches: number;
  }>(
    tx,
    sql`
    SELECT current_database() AS database, c.*, clock_timestamp() AS observed_at,
      coalesce(c.expires_at <= clock_timestamp(),false) AS expired,
      (SELECT count(*)::integer FROM public.tasks WHERE status NOT IN ('completed','failed','stopped','timed_out')) AS unfinished,
      (SELECT count(*)::integer FROM public.tasks WHERE status='stopped' AND data #>> '{metadata,restart_recovery,state}'='pending') AS restart,
      (SELECT count(*)::integer FROM public.branches WHERE filesystem_status='creating'
        OR data->'maintenance' IS NOT NULL AND data->'maintenance' <> 'null'::jsonb
        OR (data #>> '{environment_instance,command_attempt,id}' IS NOT NULL
          AND data #>> '{environment_instance,command_attempt,finished_at}' IS NULL)) AS branches
    FROM agor_maintenance.control c WHERE singleton`
  );
  if (!r) fail('Maintenance control is absent');
  return {
    version: 1,
    database: r.database,
    phase: r.phase,
    generation: r.generation,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    observedAt: new Date(r.observed_at).toISOString(),
    expired: r.expired,
    unfinishedTasks: r.unfinished,
    pendingRestartRecoveries: r.restart,
    branchOperations: r.branches,
    idleSince: r.idle_since ? new Date(r.idle_since).toISOString() : null,
    admissionDrained:
      r.phase === 'sealed' &&
      !r.expired &&
      r.unfinished === 0 &&
      r.restart === 0 &&
      r.branches === 0,
  };
}

export async function inspectMaintenanceAdmission(
  db: Database
): Promise<MaintenanceAdmissionStatus> {
  return operator(db, async (tx) => {
    await verifyInstallation(tx);
    await executeRaw(
      tx,
      sql`SELECT singleton FROM agor_maintenance.control WHERE singleton FOR SHARE`
    );
    return status(tx);
  });
}

/** Two finite calls, at least 60s apart, not a polling/daemon/job. */
export async function sealMaintenanceAdmission(
  db: Database,
  lease: MaintenanceAdmissionLease
): Promise<MaintenanceAdmissionStatus> {
  return operator(db, async (tx) => {
    await verifyInstallation(tx);
    await exactLease(tx, lease, true);
    const before = await status(tx);
    if (before.unfinishedTasks || before.pendingRestartRecoveries || before.branchOperations) {
      await executeRaw(
        tx,
        sql`UPDATE agor_maintenance.control SET idle_since=NULL WHERE singleton`
      );
      return before;
    }
    await executeRaw(
      tx,
      sql`UPDATE agor_maintenance.control SET
      phase=CASE WHEN idle_since <= clock_timestamp()-interval '60 seconds' THEN 'sealed' ELSE phase END,
      idle_since=coalesce(idle_since,clock_timestamp()) WHERE singleton`
    );
    const after = await status(tx);
    if (after.phase === 'sealed' && before.phase !== 'sealed')
      await audit(tx, 'sealed', lease.generation);
    return after;
  });
}

async function exactLease(
  tx: Database,
  lease: MaintenanceAdmissionLease,
  requireUnexpired: boolean
): Promise<void> {
  const [match] = await rows<{ valid: boolean }>(
    tx,
    sql`
    SELECT current_database()=${lease.database} AND generation=${lease.generation} AND expires_at=${lease.expiresAt}::timestamptz
      AND phase <> 'released' AND (NOT ${requireUnexpired} OR expires_at>clock_timestamp()) AS valid
    FROM agor_maintenance.control WHERE singleton FOR UPDATE`
  );
  if (!match?.valid) fail('Maintenance generation/deadline changed, released or expired');
}

/** Expiry invalidates readiness, NEVER silently reopens ingress during a cutover. */
export async function releaseMaintenanceAdmission(
  db: Database,
  lease: MaintenanceAdmissionLease
): Promise<void> {
  return operator(db, async (tx) => {
    await verifyInstallation(tx);
    await exactLease(tx, lease, false);
    await executeRaw(
      tx,
      sql`UPDATE agor_maintenance.control SET phase='released', idle_since=NULL WHERE singleton`
    );
    await audit(tx, 'released', lease.generation);
  });
}
