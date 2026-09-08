import type { QueuedPromptAmendmentPreview, Task } from '@agor-live/client';

export const EDITABLE_QUEUED_PROMPT_MAX_BYTES = 32 * 1024;

export function queuedPromptUnavailableReason(status: Task['status']): string {
  if (status === 'dispatching') {
    return 'This prompt was claimed for dispatch and is no longer editable.';
  }
  if (status === 'running') return 'This prompt is already running and is no longer editable.';
  if (status === 'stopped') {
    return 'This prompt is stopped or cancelled and is no longer editable.';
  }
  return `This prompt is ${status} and is no longer editable.`;
}

export function queuedPromptPreviewIsStale(
  live: Pick<Task, 'full_prompt' | 'metadata'>,
  preview: Pick<QueuedPromptAmendmentPreview, 'canonical_prompt' | 'prompt_revision'>
): boolean {
  return (
    (live.metadata?.queued_prompt_amendment?.current_revision ?? 0) !== preview.prompt_revision ||
    live.full_prompt !== preview.canonical_prompt
  );
}
