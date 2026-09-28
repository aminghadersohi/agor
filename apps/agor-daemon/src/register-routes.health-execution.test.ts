import { readFileSync } from 'node:fs';
import { resolveRestartRecoverySettings } from '@agor/core/config';
import { describe, expect, it } from 'vitest';

describe('/health execution block', () => {
  const source = readFileSync(new URL('./register-routes.ts', import.meta.url), 'utf8');

  it('reports resolved restart recovery only to authenticated callers', () => {
    const authenticatedStart = source.indexOf('if (isAuthenticated) {');
    const executionStart = source.indexOf('execution: {', authenticatedStart);
    const execution = source.slice(executionStart, source.indexOf('deployment: {', executionStart));
    expect(authenticatedStart).toBeGreaterThan(0);
    expect(executionStart).toBeGreaterThan(authenticatedStart);
    expect(execution).toContain(
      'restartRecovery: resolveRestartRecoverySettings(config.execution)'
    );
    // The public payload (built before the authenticated branch) never carries it.
    expect(source.slice(0, authenticatedStart)).not.toContain('restartRecovery:');
  });

  it('projects the defaults an operator gets without configuring anything', () => {
    expect(resolveRestartRecoverySettings(undefined)).toEqual({
      enabled: false,
      delayMs: 2000,
      maxTasksPerStart: 50,
      resumeAfterCrash: false,
    });
  });
});
