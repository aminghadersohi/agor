import type { Branch, ProfileImageListResult } from '@agor-live/client';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listProfileImages } from './profileImageApi';
import { useProfileImageUrl } from './useProfileImageUrl';
import { useTeammateProfileImageUrl } from './useTeammateProfileImageUrl';

vi.mock('./profileImageApi', () => ({ listProfileImages: vi.fn() }));
vi.mock('./useProfileImageUrl', () => ({ useProfileImageUrl: vi.fn() }));

function teammate(id: string, profileImageId?: string): Branch {
  return {
    branch_id: id,
    custom_context: {
      teammate: { kind: 'teammate', displayName: 'Ada', emoji: '🎨', profileImageId },
    },
  } as unknown as Branch;
}

const gallery = (imageId: string): ProfileImageListResult => ({
  max_images: 8,
  images: [
    {
      image_id: imageId,
      subject_type: 'teammate',
      subject_id: 'branch-gallery',
      created_by: 'user-1',
      original_name: 'portrait.webp',
      position: 0,
      is_primary: true,
      small_width: 128,
      small_height: 128,
      large_width: 768,
      large_height: 768,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ],
});

describe('useTeammateProfileImageUrl', () => {
  beforeEach(() => {
    vi.mocked(listProfileImages).mockReset();
    vi.mocked(useProfileImageUrl).mockImplementation((imageId) =>
      imageId ? `blob:${imageId}` : undefined
    );
  });

  it('uses the projected primary image without listing the gallery', () => {
    const { result } = renderHook(() =>
      useTeammateProfileImageUrl(teammate('branch-projected', 'image-projected'), 'small')
    );

    expect(result.current).toBe('blob:image-projected');
    expect(listProfileImages).not.toHaveBeenCalled();
  });

  it('falls back to the authoritative gallery when an older branch object lacks the projection', async () => {
    vi.mocked(listProfileImages).mockResolvedValue(gallery('image-gallery'));
    const { result } = renderHook(() =>
      useTeammateProfileImageUrl(teammate('branch-gallery'), 'small')
    );

    await waitFor(() => expect(result.current).toBe('blob:image-gallery'));
    expect(listProfileImages).toHaveBeenCalledWith({ type: 'teammate', id: 'branch-gallery' });
  });
});
