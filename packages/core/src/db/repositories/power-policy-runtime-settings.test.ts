import { resolvePowerManagementConfig } from '@agor/core/config';
import type { UserID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest, ensureTestUser } from '../test-helpers';
import { AppVariableRepository } from './app-variables';
import {
  POWER_POLICY_RUNTIME_AUDIT_NAMESPACE,
  POWER_POLICY_RUNTIME_NAMESPACE,
  POWER_POLICY_RUNTIME_STATE_KEY,
  PowerPolicyRuntimeRevisionConflictError,
  PowerPolicyRuntimeSettingsRepository,
} from './power-policy-runtime-settings';

const ACTOR = '00000000-0000-7000-8000-00000000a11c' as UserID;
const defaults = resolvePowerManagementConfig({ mode: 'off', online_stable_ms: 60_000 });

describe('PowerPolicyRuntimeSettingsRepository', () => {
  dbTest(
    'persists explicit precedence, reset, audit, and one-step rollback across restart',
    async ({ db }) => {
      await ensureTestUser(db, ACTOR);
      const repository = new PowerPolicyRuntimeSettingsRepository(db);
      await expect(repository.load(defaults)).resolves.toMatchObject({
        effective: { mode: 'off' },
        view: { revision: 0, source: 'operator_defaults', can_rollback: false },
      });

      const applied = await repository.compareAndSwap({
        expectedRevision: 0,
        operation: 'apply',
        runtimeOverride: { mode: 'observe', online_stable_ms: 75_000 },
        operatorDefaults: defaults,
        updatedBy: ACTOR,
      });
      expect(applied).toMatchObject({
        effective: { mode: 'observe', onlineStableMs: 75_000 },
        view: {
          revision: 1,
          source: 'runtime_override',
          can_rollback: true,
          rollback_target: 'runtime_override',
        },
      });

      const restarted = new PowerPolicyRuntimeSettingsRepository(db);
      await expect(restarted.load(defaults)).resolves.toMatchObject(applied);
      const reset = await restarted.compareAndSwap({
        expectedRevision: 1,
        operation: 'reset_to_operator_defaults',
        operatorDefaults: defaults,
        updatedBy: ACTOR,
      });
      expect(reset).toMatchObject({
        effective: { mode: 'off', onlineStableMs: 60_000 },
        view: { revision: 2, source: 'operator_defaults', rollback_target: 'runtime_override' },
      });
      const rollback = await restarted.compareAndSwap({
        expectedRevision: 2,
        operation: 'rollback_last_change',
        operatorDefaults: defaults,
        updatedBy: ACTOR,
      });
      expect(rollback).toMatchObject({
        effective: { mode: 'observe', onlineStableMs: 75_000 },
        view: { revision: 3, source: 'runtime_override' },
      });

      const variables = new AppVariableRepository(db);
      await expect(
        variables.find(POWER_POLICY_RUNTIME_AUDIT_NAMESPACE, '0000000000000001')
      ).resolves.toMatchObject({ metadata: { immutable_audit: true }, updated_by: ACTOR });
      await expect(
        variables.find(POWER_POLICY_RUNTIME_AUDIT_NAMESPACE, '0000000000000003')
      ).resolves.toMatchObject({ metadata: { immutable_audit: true }, updated_by: ACTOR });
    }
  );

  dbTest('rejects a stale admin compare-and-swap after one exact revision wins', async ({ db }) => {
    await ensureTestUser(db, ACTOR);
    const repository = new PowerPolicyRuntimeSettingsRepository(db);
    await repository.compareAndSwap({
      expectedRevision: 0,
      operation: 'apply',
      runtimeOverride: { mode: 'observe' },
      operatorDefaults: defaults,
      updatedBy: ACTOR,
    });
    await expect(
      repository.compareAndSwap({
        expectedRevision: 0,
        operation: 'apply',
        runtimeOverride: { mode: 'enforce' },
        operatorDefaults: defaults,
        updatedBy: ACTOR,
      })
    ).rejects.toBeInstanceOf(PowerPolicyRuntimeRevisionConflictError);
    await expect(repository.load(defaults)).resolves.toMatchObject({ view: { revision: 1 } });
  });

  dbTest(
    'rolls back to an exact prior policy even when operator defaults changed',
    async ({ db }) => {
      await ensureTestUser(db, ACTOR);
      const repository = new PowerPolicyRuntimeSettingsRepository(db);
      await repository.compareAndSwap({
        expectedRevision: 0,
        operation: 'apply',
        runtimeOverride: { mode: 'observe' },
        operatorDefaults: defaults,
        updatedBy: ACTOR,
      });
      const changedDefaults = resolvePowerManagementConfig({
        mode: 'enforce',
        online_stable_ms: 90_000,
      });
      await expect(
        repository.compareAndSwap({
          expectedRevision: 1,
          operation: 'rollback_last_change',
          operatorDefaults: changedDefaults,
          updatedBy: ACTOR,
        })
      ).resolves.toMatchObject({
        effective: { mode: 'off', onlineStableMs: 60_000 },
        view: {
          revision: 2,
          source: 'runtime_override',
          operator_defaults: { mode: 'enforce', online_stable_ms: 90_000 },
        },
      });
    }
  );

  dbTest('fails closed on a corrupt durable rollback claim', async ({ db }) => {
    await new AppVariableRepository(db).set({
      namespace: POWER_POLICY_RUNTIME_NAMESPACE,
      key: POWER_POLICY_RUNTIME_STATE_KEY,
      content_type: 'application/json',
      value: JSON.stringify({
        schema_version: 1,
        revision: 4,
        runtime_override: null,
        rollback_available: true,
        rollback_override: null,
      }),
    });
    await expect(new PowerPolicyRuntimeSettingsRepository(db).load(defaults)).rejects.toThrow(
      /unsupported shape/
    );
  });

  dbTest('runs fail-closed topology validation before a rollback is persisted', async ({ db }) => {
    await ensureTestUser(db, ACTOR);
    const repository = new PowerPolicyRuntimeSettingsRepository(db);
    await repository.compareAndSwap({
      expectedRevision: 0,
      operation: 'apply',
      runtimeOverride: { mode: 'observe' },
      operatorDefaults: defaults,
      updatedBy: ACTOR,
    });
    await expect(
      repository.compareAndSwap({
        expectedRevision: 1,
        operation: 'rollback_last_change',
        operatorDefaults: defaults,
        updatedBy: ACTOR,
        validateEffective: () => {
          throw new Error('unsupported topology sentinel');
        },
      })
    ).rejects.toThrow('unsupported topology sentinel');
    await expect(repository.load(defaults)).resolves.toMatchObject({
      effective: { mode: 'observe' },
      view: { revision: 1 },
    });
  });
});
