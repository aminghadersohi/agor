import type { AgorExecutionSettings } from './types';

export interface ResolvedRestartRecoverySettings {
  enabled: boolean;
  delayMs: number;
  maxTasksPerStart: number;
  resumeAfterCrash: boolean;
}

const DEFAULT_DELAY_MS = 2_000;
const MIN_DELAY_MS = 250;
const MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_TASKS = 50;
const MAX_TASKS_LIMIT = 500;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  key: string
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Config error: ${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function resolveRestartRecoverySettings(
  execution?: AgorExecutionSettings
): ResolvedRestartRecoverySettings {
  const configured = execution?.restart_recovery;
  return {
    enabled: configured?.enabled === true,
    delayMs: boundedInteger(
      configured?.delay_ms,
      DEFAULT_DELAY_MS,
      MIN_DELAY_MS,
      MAX_DELAY_MS,
      'execution.restart_recovery.delay_ms'
    ),
    maxTasksPerStart: boundedInteger(
      configured?.max_tasks_per_start,
      DEFAULT_MAX_TASKS,
      1,
      MAX_TASKS_LIMIT,
      'execution.restart_recovery.max_tasks_per_start'
    ),
    resumeAfterCrash: configured?.resume_after_crash === true,
  };
}
