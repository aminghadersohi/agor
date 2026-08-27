import type { ProfileImage } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProfileIdentityModelBlob, generateProfileIdentityModel } from './profileImageApi';
import { useProfileIdentityModel } from './useProfileIdentityModel';
import { publishProfileImageMetadata } from './useProfileImageGallery';

vi.mock('./profileImageApi', () => ({
  fetchProfileIdentityModelBlob: vi.fn(),
  generateProfileIdentityModel: vi.fn(),
  refreshProfileIdentityModel: vi.fn(),
}));
vi.mock('./useProfileImageGallery', () => ({ publishProfileImageMetadata: vi.fn() }));

function image(updatedAt: string, available = true): ProfileImage {
  return {
    image_id: 'image-1',
    subject_type: 'user',
    subject_id: 'user-1',
    created_by: 'user-1',
    original_name: 'portrait.png',
    position: 0,
    is_primary: true,
    small_width: 96,
    small_height: 96,
    large_width: 768,
    large_height: 768,
    identity_model: {
      provider: 'meshy',
      status: available ? 'succeeded' : 'failed',
      progress: available ? 100 : 0,
      model_available: available,
      created_at: '2026-08-26T00:00:00.000Z',
      updated_at: updatedAt,
    },
    created_at: '2026-08-26T00:00:00.000Z',
    updated_at: updatedAt,
  } as ProfileImage;
}

describe('useProfileIdentityModel', () => {
  beforeEach(() => {
    const NativeURL = URL;
    class MockURL extends NativeURL {}
    Object.assign(MockURL, {
      createObjectURL: vi.fn(() => 'blob:stored-glb'),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal('URL', MockURL);
    vi.mocked(fetchProfileIdentityModelBlob).mockResolvedValue(
      new Blob(['glTF'], { type: 'model/gltf-binary' })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the private GLB and refreshes it when a regenerated model version changes', async () => {
    const { result, rerender, unmount } = renderHook(
      ({ value }) => useProfileIdentityModel(value, true),
      { initialProps: { value: image('2026-08-26T00:01:00.000Z') } }
    );

    await waitFor(() => expect(result.current.modelUrl).toBe('blob:stored-glb'));
    rerender({ value: image('2026-08-26T00:02:00.000Z') });
    await waitFor(() => expect(fetchProfileIdentityModelBlob).toHaveBeenCalledTimes(2));
    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('publishes generation metadata so every profile surface sees current status', async () => {
    const pending = {
      ...image('2026-08-26T00:03:00.000Z', false),
      identity_model: {
        ...image('2026-08-26T00:03:00.000Z', false).identity_model!,
        status: 'pending' as const,
      },
    };
    vi.mocked(generateProfileIdentityModel).mockResolvedValue(pending);
    const initial = image('old', false);
    const { result } = renderHook(() => useProfileIdentityModel(initial, true));

    await act(async () => result.current.generate());

    expect(publishProfileImageMetadata).toHaveBeenCalledWith(pending);
    expect(result.current.identityModel?.status).toBe('pending');
  });
});
