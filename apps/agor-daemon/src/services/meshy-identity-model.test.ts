import { describe, expect, it, vi } from 'vitest';
import { MeshyIdentityModelClient } from './meshy-identity-model.js';

describe('MeshyIdentityModelClient', () => {
  it('submits a private PNG data URI without exposing the API key', async () => {
    const apiFetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        image_url: 'data:image/png;base64,aW1hZ2U=',
        target_formats: ['glb'],
        moderation: true,
      });
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
      return Response.json({ result: 'provider-task-1' });
    });
    const client = new MeshyIdentityModelClient('test-key', {
      apiFetch: apiFetch as typeof fetch,
    });

    await expect(client.create(Buffer.from('image'))).resolves.toBe('provider-task-1');
  });

  it('normalizes progress and accepts only documented statuses', async () => {
    const apiFetch = vi.fn(async () =>
      Response.json({
        id: 'provider-task-1',
        status: 'SUCCEEDED',
        progress: 104,
        model_urls: { glb: 'https://assets.meshy.ai/model.glb?signature=redacted' },
      })
    );
    const client = new MeshyIdentityModelClient('test-key', {
      apiFetch: apiFetch as typeof fetch,
    });

    await expect(client.get('provider-task-1')).resolves.toEqual({
      id: 'provider-task-1',
      status: 'SUCCEEDED',
      progress: 100,
      modelUrl: 'https://assets.meshy.ai/model.glb?signature=redacted',
    });
  });

  it('rejects non-Meshy downloads and invalid GLB bytes', async () => {
    const modelFetch = vi.fn(async () => new Response(Buffer.from('not-a-glb')));
    const client = new MeshyIdentityModelClient('test-key', {
      modelFetch: modelFetch as typeof fetch,
    });

    await expect(client.downloadGlb('https://example.test/model.glb')).rejects.toThrow(
      'invalid model download location'
    );
    await expect(client.downloadGlb('https://assets.meshy.ai/model.glb')).rejects.toThrow(
      'invalid GLB'
    );
  });

  it('returns stable credential and credit errors without reflecting provider bodies', async () => {
    const client = new MeshyIdentityModelClient('test-key', {
      apiFetch: vi.fn(
        async () => new Response('secret provider body', { status: 402 })
      ) as typeof fetch,
    });
    await expect(client.create(Buffer.from('image'))).rejects.toThrow('credits are required');
  });

  it('deletes provider data after Agor has copied the GLB', async () => {
    const apiFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const client = new MeshyIdentityModelClient('test-key', {
      apiFetch: apiFetch as typeof fetch,
    });

    await client.delete('provider-task-1');

    expect(apiFetch).toHaveBeenCalledWith(
      'https://api.meshy.ai/openapi/v1/image-to-3d/provider-task-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bearer test-key' },
      })
    );
  });
});
