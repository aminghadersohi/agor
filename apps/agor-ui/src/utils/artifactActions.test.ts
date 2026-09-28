import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchArtifactDataBinding, runArtifactActionBinding } from './artifactActions';

describe('runArtifactActionBinding', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts to the artifact-scoped action route and never names a schedule', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ action_id: 'run-once', effect: 'schedule_run' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(runArtifactActionBinding('artifact/1', 'run once')).resolves.toMatchObject({
      action_id: 'run-once',
    });
    // Both segments are encoded, and the body is empty: the binding id is the
    // only thing that travels, so there is nowhere to smuggle an argument.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/artifacts/artifact%2F1/actions/run%20once'),
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

    await expect(runArtifactActionBinding('artifact-1', 'run-once')).rejects.toThrow(
      'x'.repeat(300)
    );
    await expect(runArtifactActionBinding('artifact-1', 'run-once')).rejects.not.toThrow(
      /do-not-return/
    );
  });
});

describe('fetchArtifactDataBinding', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the artifact-scoped data route with GET', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ kind: 'schedule_status', enabled: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(fetchArtifactDataBinding('artifact-1', 'nightly')).resolves.toMatchObject({
      kind: 'schedule_status',
      enabled: true,
    });
    // A read is a GET with no body — structurally incapable of carrying a
    // mutation, which is half of why reads and writes are separate routes.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/artifacts/artifact-1/data/nightly'),
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body');
  });

  it('surfaces a bounded error when the binding is not declared', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'does not declare data binding "nope"' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(fetchArtifactDataBinding('artifact-1', 'nope')).rejects.toThrow(
      'does not declare data binding'
    );
  });
});
