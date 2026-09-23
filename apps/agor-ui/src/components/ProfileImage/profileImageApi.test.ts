import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchProfileIdentityModelBlob,
  generateProfileIdentityModel,
  listProfileImages,
} from './profileImageApi';

const auth = vi.hoisted(() => ({ token: 'stale-access' as string | null }));
const refreshTokensSingleFlight = vi.hoisted(() => vi.fn());

vi.mock('@agor-live/client', () => ({ createRestClient: vi.fn(async () => ({ rest: true })) }));
vi.mock('../../config/daemon', () => ({ getDaemonUrl: () => 'http://daemon.test:3030' }));
vi.mock('../../utils/authHeaders', () => ({
  getAgorAccessToken: () => auth.token,
  getAuthHeaders: () => ({
    'Content-Type': 'application/json',
    ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
  }),
}));
vi.mock('../../utils/tokenRefresh', () => ({ getStoredRefreshToken: () => 'refresh-token' }));
vi.mock('../../utils/singleFlightRefresh', () => ({ refreshTokensSingleFlight }));

describe('profileImageApi authentication recovery', () => {
  beforeEach(() => {
    auth.token = 'stale-access';
    vi.stubGlobal('fetch', vi.fn());
    refreshTokensSingleFlight.mockReset().mockImplementation(async () => {
      auth.token = 'fresh-access';
      return { accessToken: 'fresh-access' };
    });
  });

  it('refreshes once and retries a profile request after an expired-token 401', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ images: [], max_images: 8 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    await expect(listProfileImages({ type: 'teammate', id: 'branch-1' })).resolves.toEqual({
      images: [],
      max_images: 8,
    });

    expect(refreshTokensSingleFlight).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://daemon.test:3030/profile-images?subjectType=teammate&subjectId=branch-1',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer stale-access' }),
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'http://daemon.test:3030/profile-images?subjectType=teammate&subjectId=branch-1',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fresh-access' }),
      })
    );
  });

  it('requires explicit consent in the generation request and keeps model bytes authenticated', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json(
          {
            image_id: 'image-1',
            identity_model: {
              provider: 'meshy',
              status: 'pending',
              progress: 0,
              model_available: false,
            },
          },
          { status: 202 }
        )
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46]), {
          status: 200,
          headers: { 'Content-Type': 'model/gltf-binary' },
        })
      );

    await generateProfileIdentityModel('image-1');
    const blob = await fetchProfileIdentityModelBlob('image-1');

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'http://daemon.test:3030/profile-images/image-1/identity-model',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ consent: true }),
        headers: expect.objectContaining({ Authorization: 'Bearer stale-access' }),
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'http://daemon.test:3030/profile-images/image-1/identity-model/file',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer stale-access' }),
      })
    );
    expect(blob.type).toBe('model/gltf-binary');
  });
});
