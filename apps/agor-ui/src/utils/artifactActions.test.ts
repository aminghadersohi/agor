import type { ScheduleID } from '@agor-live/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runArtifactScheduleAction } from './artifactActions';

describe('runArtifactScheduleAction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the authenticated run-now route', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ session_id: 'session-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(runArtifactScheduleAction('schedule/id' as ScheduleID)).resolves.toMatchObject({
      session_id: 'session-1',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/schedules/schedule%2Fid/run-now'),
      expect.objectContaining({ method: 'POST', body: '{}' })
    );
  });

  it('returns a bounded server error without exposing an arbitrary body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'x'.repeat(500), secret: 'do-not-return' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(runArtifactScheduleAction('schedule-1' as ScheduleID)).rejects.toThrow(
      'x'.repeat(300)
    );
  });
});
