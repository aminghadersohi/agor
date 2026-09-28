import type { SessionID, Task, TaskID, TaskMetadata, UserID } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { getTaskAuditTags, mergedRequestCount } from './taskAudit';

const TASK_ID = '01900000-0000-7000-8000-000000000001' as TaskID;
const OTHER_TASK = '01900000-0000-7000-8000-00000000000b' as TaskID;
const PARENT = '01900000-0000-7000-8000-0000000000aa' as SessionID;
const DIGEST = '01900000-0000-7000-8000-0000000000dd' as SessionID;
const USER = 'user-1' as UserID;
const AT = '2026-09-27T12:00:00.000Z';

function tagsFor(metadata: TaskMetadata | undefined) {
  return getTaskAuditTags({ task_id: TASK_ID, metadata } as Pick<Task, 'task_id' | 'metadata'>);
}

function request(n: number) {
  return {
    request_id: `01900000-0000-7000-8000-00000000010${n}` as TaskID,
    submitted_at: AT,
    created_by: USER,
    text: `prompt ${n}`,
    normalized_text: `prompt ${n}`,
  };
}

describe('getTaskAuditTags', () => {
  it('renders nothing for an ordinary prompt', () => {
    expect(tagsFor(undefined)).toEqual([]);
    expect(tagsFor({ source: 'user', queued_by_user_id: USER })).toEqual([]);
  });

  it('keeps the coordinator batch labels and links the coordinator', () => {
    const [tag] = tagsFor({
      coordinator_queue_batch: {
        version: 1,
        operation_id: 'op',
        strategy: 'combine',
        batched_at: AT,
        requested_by_user_id: USER,
        coordinator_session_id: PARENT,
        relationship: 'coordinator',
        expected_queue_revision: 'r',
        source_task_count: 2,
        source_request_count: 3,
        unique_request_count: 3,
        duplicate_request_count: 0,
        source_tasks: [],
      },
    });
    expect(tag).toMatchObject({ label: '3 requests → 1 turn (combine)', session: PARENT });
  });

  it('counts merged busy-session requests only when more than one shares the turn', () => {
    const compaction = (count: number, duplicates = 0): TaskMetadata => ({
      prompt_compaction: {
        version: 1,
        max_combined_prompt_bytes: 1000,
        requests: Array.from({ length: count }, (_, i) => request(i + 1)),
        unique_prompt_count: count - duplicates,
        duplicate_request_count: duplicates,
        last_admitted_request_id: request(count).request_id,
      },
    });
    expect(tagsFor(compaction(1))).toEqual([]);
    const [tag] = tagsFor(compaction(3, 1));
    expect(tag.label).toBe('3 requests merged');
    expect(tag.tooltip).toContain('1 duplicate not repeated');
    expect(mergedRequestCount({ metadata: compaction(3) })).toBe(3);
    expect(mergedRequestCount({ metadata: undefined })).toBe(0);
  });

  it('shows the edit revision, or cancellation instead of it', () => {
    const revision = {
      revision: 2,
      operation_id: 'op',
      amended_at: AT,
      amended_by_user_id: USER,
      authority: 'parent' as const,
      text: 'x',
    };
    const [edited] = tagsFor({
      queued_prompt_amendment: {
        version: 1,
        original_prompt: 'x',
        current_revision: 2,
        revisions: [revision, revision],
      },
    });
    expect(edited.label).toBe('Edited r2');
    expect(edited.tooltip).toContain('last edit by its parent');

    expect(
      tagsFor({
        queued_prompt_amendment: {
          version: 1,
          original_prompt: 'x',
          current_revision: 0,
          revisions: [],
        },
      })
    ).toEqual([]);

    const [cancelled] = tagsFor({
      queued_prompt_amendment: {
        version: 1,
        original_prompt: 'x',
        current_revision: 1,
        revisions: [revision],
        cancellation: {
          operation_id: 'op2',
          cancelled_at: AT,
          cancelled_by_user_id: USER,
          authority: 'author',
          revision: 1,
        },
      },
    });
    expect(cancelled.label).toBe('Cancelled before dispatch');
  });

  it('links the interrupting session on both the interrupted and corrective task', () => {
    const interruption = {
      requested_by_session_id: PARENT,
      requested_by_user_id: USER,
      relationship: 'parent' as const,
      target_task_id: TASK_ID,
      corrective_task_id: OTHER_TASK,
      idempotency_key: 'k',
      requested_at: AT,
    };
    expect(tagsFor({ interruptions: [interruption] })[0]).toMatchObject({
      label: 'Interrupted by',
      session: PARENT,
    });
    expect(tagsFor({ interruptions: [interruption, interruption] })[0].label).toBe(
      'Interrupted ×2 by'
    );
    expect(tagsFor({ interrupt_correction: interruption })[0]).toMatchObject({
      label: 'Correction from',
      session: PARENT,
    });
  });

  it('shows callback delivery, the fallback reason and the digest fork', () => {
    const base = {
      source_session_id: PARENT,
      source_task_id: OTHER_TASK,
      destination_session_id: DIGEST,
      relationship_ids: [],
      route: 'standing' as const,
    };
    const [digest] = tagsFor({
      callback_delivery: {
        ...base,
        requested_delivery: 'btw',
        resolved_delivery: 'btw',
        btw_session_id: DIGEST,
      },
    });
    expect(digest).toMatchObject({
      label: 'Callback via digest',
      session: DIGEST,
      status: 'default',
    });

    const [fallback] = tagsFor({
      callback_delivery: {
        ...base,
        requested_delivery: 'btw',
        resolved_delivery: 'direct',
        fallback_reason: 'destination_inactive',
      },
    });
    expect(fallback).toMatchObject({ label: 'Callback · direct', status: 'warning' });
    expect(fallback.session).toBeUndefined();
    expect(fallback.tooltip).toContain('Requested btw, delivered direct.');
    expect(fallback.tooltip).toContain('the destination session was inactive');
  });

  it('marks reminder-fired turns', () => {
    const [tag] = tagsFor({
      session_reminder: {
        reminder_id: 'rem-1' as never,
        due_at: AT,
        created_at: AT,
        one_shot: true,
      },
    });
    expect(tag.label).toBe('Reminder');
  });

  it('distinguishes the restart continuation from its interrupted source', () => {
    const recovery = (
      source: TaskID,
      state: 'pending' | 'admitted' | 'superseded'
    ): TaskMetadata => ({
      restart_recovery: {
        source_task_id: source,
        state,
        requested_at: AT,
        ...(state === 'superseded' ? { disposition_reason: 'session_archived' as const } : {}),
      },
    });
    expect(tagsFor(recovery(OTHER_TASK, 'admitted'))[0].label).toBe('Recovered after restart');
    expect(tagsFor(recovery(TASK_ID, 'admitted'))[0].label).toBe('Resumed after restart');
    expect(tagsFor(recovery(TASK_ID, 'pending'))[0].label).toBe('Recovery pending');
    const [skipped] = tagsFor(recovery(TASK_ID, 'superseded'));
    expect(skipped.label).toBe('Recovery skipped');
    expect(skipped.tooltip).toContain('the session was archived');
  });

  it('counts skipped and failed gateway attachments together', () => {
    const [tag] = tagsFor({
      gateway_skipped_attachments: {
        skipped: 2,
        skipped_mime_types: ['application/zip', 'application/zip'],
        failed: 1,
      },
    });
    expect(tag.label).toBe('3 attachments not delivered');
    expect(tag.tooltip).toContain('2 unsupported (application/zip).');
    expect(tag.tooltip).toContain('1 could not be fetched.');
    expect(
      tagsFor({ gateway_skipped_attachments: { skipped: 1, skipped_mime_types: [], failed: 0 } })[0]
        .label
    ).toBe('1 attachment not delivered');
  });

  it('marks MCP-relayed prompts and says the stamp attests the hop, not approval', () => {
    const provenance = (
      overrides: Partial<NonNullable<TaskMetadata['prompt_provenance']>>
    ): TaskMetadata => ({
      prompt_provenance: {
        version: 1,
        authenticated_by: 'session_token',
        origin_session_id: PARENT,
        origin_user_id: USER,
        origin_agentic_tool: 'claude-code',
        tool: 'agor_sessions_prompt',
        mode: 'continue',
        stamped_at: AT,
        rendered_block: '<agor_prompt_provenance/>',
        placement: 'prefix',
        ...overrides,
      },
    });

    const [signed] = tagsFor(provenance({}));
    expect(signed.label).toBe('Relayed by agent');
    expect(signed.session).toBe(PARENT);
    expect(signed.tooltip).toContain('claude-code via agor_sessions_prompt (continue)');
    expect(signed.tooltip).toContain('signed session token');
    expect(signed.tooltip).toContain('not that a human read or approved');

    const [apiKey] = tagsFor(
      provenance({ authenticated_by: 'personal_api_key', origin_session_id: undefined })
    );
    expect(apiKey.label).toBe('Relayed by agent (unattributed)');
    expect(apiKey.session).toBeUndefined();
    expect(apiKey.tooltip).toContain('personal API key');
  });
});
