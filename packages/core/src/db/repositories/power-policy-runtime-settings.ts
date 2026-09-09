import { and, eq } from 'drizzle-orm';
import {
  powerManagementMutableSettingsFromResolved,
  powerManagementSettingsFromResolved,
  type ResolvedPowerManagementConfig,
  resolvePowerManagementRuntimeOverlay,
} from '../../config';
import { generateId } from '../../lib/ids';
import type {
  PowerManagementMutableSettings,
  PowerManagementRuntimeSettingsView,
  UserID,
} from '../../types';
import type { Database } from '../client';
import {
  insert,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { appVariables } from '../schema';
import { AppVariableRepository } from './app-variables';
import { currentTenantInsert, RepositoryError } from './base';

export const POWER_POLICY_RUNTIME_NAMESPACE = 'power_policy_runtime';
export const POWER_POLICY_RUNTIME_STATE_KEY = 'state';
export const POWER_POLICY_RUNTIME_AUDIT_NAMESPACE = 'power_policy_runtime_audit';

interface StoredPowerPolicyRuntimeState {
  schema_version: 1;
  revision: number;
  runtime_override: PowerManagementMutableSettings | null;
  rollback_override?: PowerManagementMutableSettings | null;
  rollback_available?: boolean;
  updated_at?: string;
  updated_by?: UserID;
}

export interface ResolvedPowerPolicyRuntimeState {
  view: PowerManagementRuntimeSettingsView;
  effective: ResolvedPowerManagementConfig;
}

export class PowerPolicyRuntimeRevisionConflictError extends RepositoryError {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `Power policy changed in another admin session (expected revision ${expectedRevision}, current revision ${actualRevision})`
    );
    this.name = 'PowerPolicyRuntimeRevisionConflictError';
  }
}

function emptyState(): StoredPowerPolicyRuntimeState {
  return { schema_version: 1, revision: 0, runtime_override: null };
}

function parseState(raw: string | null): StoredPowerPolicyRuntimeState {
  if (!raw) return emptyState();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new RepositoryError('Stored power policy runtime state is not valid JSON', error);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RepositoryError('Stored power policy runtime state is not an object');
  }
  const state = value as Partial<StoredPowerPolicyRuntimeState>;
  if (
    state.schema_version !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision ?? -1) < 0 ||
    (state.runtime_override !== null &&
      (typeof state.runtime_override !== 'object' || Array.isArray(state.runtime_override))) ||
    (state.rollback_override !== undefined &&
      state.rollback_override !== null &&
      (typeof state.rollback_override !== 'object' || Array.isArray(state.rollback_override))) ||
    (state.rollback_available !== undefined && typeof state.rollback_available !== 'boolean') ||
    (state.rollback_available === true && state.rollback_override == null) ||
    (state.updated_at !== undefined && typeof state.updated_at !== 'string') ||
    (state.updated_by !== undefined && typeof state.updated_by !== 'string')
  ) {
    throw new RepositoryError('Stored power policy runtime state has an unsupported shape');
  }
  return state as StoredPowerPolicyRuntimeState;
}

function resolveState(
  stored: StoredPowerPolicyRuntimeState,
  operatorDefaults: ResolvedPowerManagementConfig
): ResolvedPowerPolicyRuntimeState {
  const effective = resolvePowerManagementRuntimeOverlay(
    operatorDefaults,
    stored.runtime_override ?? undefined
  );
  if (stored.rollback_available) {
    // Validate the rollback snapshot on load as well as at mutation time so a
    // corrupted durable row fails startup instead of lying about recoverability.
    resolvePowerManagementRuntimeOverlay(operatorDefaults, stored.rollback_override ?? undefined);
  }
  const runtimeOverride = stored.runtime_override
    ? powerManagementMutableSettingsFromResolved(effective)
    : undefined;
  return {
    effective,
    view: {
      revision: stored.revision,
      source: runtimeOverride ? 'runtime_override' : 'operator_defaults',
      operator_defaults: powerManagementSettingsFromResolved(operatorDefaults),
      ...(runtimeOverride ? { runtime_override: runtimeOverride } : {}),
      ...(stored.updated_at ? { updated_at: stored.updated_at } : {}),
      ...(stored.updated_by ? { updated_by: stored.updated_by } : {}),
      can_rollback: stored.rollback_available === true,
      ...(stored.rollback_available
        ? {
            rollback_target: 'runtime_override' as const,
          }
        : {}),
    },
  };
}

/** Tenant-owned durable overlay and append-only audit, both stored under RLS-protected app_variables. */
export class PowerPolicyRuntimeSettingsRepository {
  constructor(private readonly db: Database) {}

  async load(
    operatorDefaults: ResolvedPowerManagementConfig
  ): Promise<ResolvedPowerPolicyRuntimeState> {
    const raw = await new AppVariableRepository(this.db).getPlain(
      POWER_POLICY_RUNTIME_NAMESPACE,
      POWER_POLICY_RUNTIME_STATE_KEY
    );
    return resolveState(parseState(raw), operatorDefaults);
  }

  async compareAndSwap(input: {
    expectedRevision: number;
    operation: 'apply' | 'reset_to_operator_defaults' | 'rollback_last_change';
    runtimeOverride?: PowerManagementMutableSettings;
    operatorDefaults: ResolvedPowerManagementConfig;
    updatedBy: UserID;
    /** Last fail-closed check, evaluated inside the CAS transaction before any write. */
    validateEffective?: (config: ResolvedPowerManagementConfig) => void;
  }): Promise<ResolvedPowerPolicyRuntimeState> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new RepositoryError('Expected power policy revision must be a non-negative integer');
    }

    // Resolve and normalize before opening the transaction. Validation failures
    // never create a state row or an audit record.
    const normalizedRequestedOverride = input.runtimeOverride
      ? powerManagementMutableSettingsFromResolved(
          resolvePowerManagementRuntimeOverlay(input.operatorDefaults, input.runtimeOverride)
        )
      : null;

    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        const variables = new AppVariableRepository(tx);
        await variables.setIfAbsent({
          namespace: POWER_POLICY_RUNTIME_NAMESPACE,
          key: POWER_POLICY_RUNTIME_STATE_KEY,
          value: JSON.stringify(emptyState()),
          content_type: 'application/json',
        });
        const stateWhere = and(
          eq(appVariables.namespace, POWER_POLICY_RUNTIME_NAMESPACE),
          eq(appVariables.key, POWER_POLICY_RUNTIME_STATE_KEY)
        )!;
        await lockRowForUpdate(tx, this.db, appVariables, stateWhere);
        const row = await select(tx, { value_text: appVariables.value_text })
          .from(appVariables)
          .where(stateWhere)
          .one();
        const previous = parseState(row?.value_text ?? null);
        if (previous.revision !== input.expectedRevision) {
          throw new PowerPolicyRuntimeRevisionConflictError(
            input.expectedRevision,
            previous.revision
          );
        }
        if (previous.revision === Number.MAX_SAFE_INTEGER) {
          throw new RepositoryError('Power policy revision is exhausted');
        }

        if (input.operation === 'rollback_last_change' && !previous.rollback_available) {
          throw new RepositoryError('No prior power policy revision is available to roll back');
        }

        const normalizedOverride =
          input.operation === 'rollback_last_change'
            ? (previous.rollback_override ?? null)
            : input.operation === 'reset_to_operator_defaults'
              ? null
              : normalizedRequestedOverride;
        // Rollback is an exact policy snapshot, not a pointer to mutable
        // operator defaults. An operator YAML edit between revisions therefore
        // cannot change what "last policy" means.
        const previousEffective = resolvePowerManagementRuntimeOverlay(
          input.operatorDefaults,
          previous.runtime_override ?? undefined
        );
        const nextEffective = resolvePowerManagementRuntimeOverlay(
          input.operatorDefaults,
          normalizedOverride ?? undefined
        );
        input.validateEffective?.(nextEffective);

        const now = new Date();
        const next: StoredPowerPolicyRuntimeState = {
          schema_version: 1,
          revision: previous.revision + 1,
          runtime_override: normalizedOverride,
          rollback_override: powerManagementMutableSettingsFromResolved(previousEffective),
          rollback_available: true,
          updated_at: now.toISOString(),
          updated_by: input.updatedBy,
        };
        const nextRaw = JSON.stringify(next);
        const updateResult = await update(tx, appVariables)
          .set({
            value_text: nextRaw,
            updated_by: input.updatedBy,
            updated_at: now,
          })
          .where(stateWhere)
          .run();
        if (updateResult.rowsAffected !== 1) {
          throw new RepositoryError('Power policy state disappeared during compare-and-swap');
        }

        const auditKey = String(next.revision).padStart(16, '0');
        await insert(tx, appVariables)
          .values({
            ...currentTenantInsert(),
            variable_id: generateId(),
            namespace: POWER_POLICY_RUNTIME_AUDIT_NAMESPACE,
            key: auditKey,
            value_text: JSON.stringify({
              schema_version: 1,
              revision: next.revision,
              operation: input.operation,
              previous_runtime_override: previous.runtime_override,
              runtime_override: normalizedOverride,
              updated_at: next.updated_at,
              updated_by: input.updatedBy,
            }),
            value_encrypted: null,
            is_encrypted: false,
            content_type: 'application/json',
            metadata: { immutable_audit: true },
            updated_by: input.updatedBy,
            created_at: now,
            updated_at: now,
          })
          .run();

        return resolveState(next, input.operatorDefaults);
      },
      { sqliteImmediate: true }
    );
  }
}
