import { describe, expect, it } from 'vitest';
import {
  queuedPromptPreviewIsStale,
  queuedPromptUnavailableReason,
} from './queuedPromptEditorState';

describe('queued prompt editor realtime state', () => {
  it('marks another-tab revisions stale instead of allowing last-write-wins', () => {
    expect(
      queuedPromptPreviewIsStale(
        {
          full_prompt: 'authoritative revision',
          metadata: {
            queued_prompt_amendment: {
              version: 1,
              original_prompt: 'original',
              current_revision: 1,
              revisions: [],
            },
          },
        },
        { canonical_prompt: 'original', prompt_revision: 0 }
      )
    ).toBe(true);
  });

  it('explains claim, running, cancellation, and terminal transitions precisely', () => {
    expect(queuedPromptUnavailableReason('dispatching')).toMatch(/claimed for dispatch/);
    expect(queuedPromptUnavailableReason('running')).toMatch(/already running/);
    expect(queuedPromptUnavailableReason('stopped')).toMatch(/stopped or cancelled/);
    expect(queuedPromptUnavailableReason('completed')).toMatch(/completed/);
  });
});
