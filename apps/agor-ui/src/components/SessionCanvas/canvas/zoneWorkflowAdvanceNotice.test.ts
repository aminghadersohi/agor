import { describe, expect, it } from 'vitest';
import { getZoneWorkflowAdvanceNotice } from './zoneWorkflowAdvanceNotice';

const receipt = (prompt_outcome: 'not_requested' | 'target_has_no_trigger' | 'failed') => ({
  entities: [{ entity_type: 'branch' as const, entity_id: 'branch-1' as never }],
  prompt_outcome,
});

describe('getZoneWorkflowAdvanceNotice', () => {
  it('reports a normal successful advance', () => {
    expect(getZoneWorkflowAdvanceNotice(receipt('not_requested'))).toEqual({
      kind: 'success',
      message: 'Advanced 1 item.',
    });
  });

  it('makes a missing target trigger explicit', () => {
    expect(getZoneWorkflowAdvanceNotice(receipt('target_has_no_trigger'))).toEqual({
      kind: 'warning',
      message:
        'Advanced 1 item. The target-zone prompt was not run because the target zone has no trigger.',
    });
  });

  it('does not hide target prompt failure details', () => {
    expect(
      getZoneWorkflowAdvanceNotice({ ...receipt('failed'), prompt_error: 'fictional failure' })
    ).toEqual({
      kind: 'error',
      message: 'Advanced 1 item, but the target-zone prompt failed: fictional failure',
    });
  });

  it('makes an idempotent replay a clear no-op', () => {
    expect(getZoneWorkflowAdvanceNotice({ ...receipt('not_requested'), replayed: true })).toEqual({
      kind: 'warning',
      message: 'Already advanced 1 item; no changes were applied.',
    });
  });
});
