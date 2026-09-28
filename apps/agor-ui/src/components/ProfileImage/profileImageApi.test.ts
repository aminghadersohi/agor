import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listProfileImages } from './profileImageApi';

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
});
