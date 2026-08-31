import type { ZoneWorkflowAdvance } from '@agor/core';

export type ZoneWorkflowAdvanceNotice = {
  kind: 'success' | 'warning' | 'error';
  message: string;
};

/** Turn the durable prompt receipt into feedback that does not hide a partial failure/no-op. */
export function getZoneWorkflowAdvanceNotice(
  audit: Pick<ZoneWorkflowAdvance, 'entities' | 'prompt_outcome' | 'prompt_error' | 'replayed'>
): ZoneWorkflowAdvanceNotice {
  const moved = `${audit.entities.length} ${audit.entities.length === 1 ? 'item' : 'items'}`;
  if (audit.replayed) {
    return { kind: 'warning', message: `Already advanced ${moved}; no changes were applied.` };
  }
  if (audit.prompt_outcome === 'failed') {
    return {
      kind: 'error',
      message: `Advanced ${moved}, but the target-zone prompt failed${audit.prompt_error ? `: ${audit.prompt_error}` : '.'}`,
    };
  }
  if (audit.prompt_outcome === 'target_has_no_trigger') {
    return {
      kind: 'warning',
      message: `Advanced ${moved}. The target-zone prompt was not run because the target zone has no trigger.`,
    };
  }
  if (audit.prompt_outcome === 'target_requires_picker') {
    return {
      kind: 'warning',
      message: `Advanced ${moved}. The target-zone prompt needs a manual session choice.`,
    };
  }
  return { kind: 'success', message: `Advanced ${moved}.` };
}
