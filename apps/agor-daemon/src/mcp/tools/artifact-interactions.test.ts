import { describe, expect, it } from 'vitest';
import type { McpContext } from '../server.js';
import {
  ArtifactInteractionConfigInputSchema,
  toArtifactInteractionConfig,
} from './artifact-interactions.js';

const SCHEDULE = '019f0000-0000-7000-8000-00000000000a';
const SESSION = '019f0000-0000-7000-8000-00000000000b';

/** Resolves the short ids `sched` and `sess`; anything else is not found. */
function makeCtx(): McpContext {
  const known: Record<string, Record<string, unknown>> = {
    schedules: { sched: { schedule_id: SCHEDULE } },
    sessions: { sess: { session_id: SESSION } },
  };
  return {
    baseServiceParams: {},
    app: {
      service: (path: string) => ({
        get: async (id: string) => {
          const entity = known[path]?.[id];
          if (!entity) throw new Error(`No record found for id '${id}'`);
          return entity;
        },
      }),
    },
  } as unknown as McpContext;
}

describe('toArtifactInteractionConfig', () => {
  it('converts the authoring shape to canonical bindings with full ids', async () => {
    const input = ArtifactInteractionConfigInputSchema.parse({
      data: [{ id: 'nightly', label: 'Nightly', kind: 'schedule_status', scheduleId: 'sched' }],
      actions: [
        { id: 'run-now', label: 'Run once', scheduleId: 'sched', confirm: true },
        { id: 'arm', label: 'Arm', scheduleId: 'sched', effect: 'enable' },
        { id: 'disarm', label: 'Disarm', scheduleId: 'sched', effect: 'disable' },
      ],
      chats: [{ id: 'triage', label: 'Triage', sessionId: 'sess' }],
    });

    await expect(toArtifactInteractionConfig(makeCtx(), input)).resolves.toEqual({
      data: [
        {
          id: 'nightly',
          label: 'Nightly',
          source: { kind: 'schedule_status', schedule_id: SCHEDULE },
        },
      ],
      actions: [
        {
          id: 'run-now',
          label: 'Run once',
          confirm: true,
          effect: { kind: 'schedule_run', schedule_id: SCHEDULE },
        },
        {
          id: 'arm',
          label: 'Arm',
          effect: { kind: 'schedule_set_enabled', schedule_id: SCHEDULE, enabled: true },
        },
        {
          id: 'disarm',
          label: 'Disarm',
          effect: { kind: 'schedule_set_enabled', schedule_id: SCHEDULE, enabled: false },
        },
      ],
      chats: [{ id: 'triage', label: 'Triage', session_id: SESSION }],
    });
  });

  it('passes null (clear) and undefined (unchanged) through', async () => {
    await expect(toArtifactInteractionConfig(makeCtx(), null)).resolves.toBeNull();
    await expect(toArtifactInteractionConfig(makeCtx(), undefined)).resolves.toBeUndefined();
  });

  it('names the binding when an id cannot be resolved or does not fit the kind', async () => {
    await expect(
      toArtifactInteractionConfig(makeCtx(), {
        actions: [{ id: 'run', label: 'Run', scheduleId: 'missing' }],
      })
    ).rejects.toThrow(
      'interactionConfig.actions[0] ("run"): schedule "missing" could not be resolved'
    );
    await expect(
      toArtifactInteractionConfig(makeCtx(), {
        data: [{ id: 'd', label: 'D', kind: 'session_status', scheduleId: 'sched' }],
      })
    ).rejects.toThrow('interactionConfig.data[0] ("d"): session_status takes sessionId only');
  });

  it('refuses fields the schema does not define, such as arguments', () => {
    expect(
      ArtifactInteractionConfigInputSchema.safeParse({
        actions: [{ id: 'run', label: 'Run', scheduleId: 'sched', args: { prompt: 'x' } }],
      }).success
    ).toBe(false);
  });
});
