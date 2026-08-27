import type { Branch } from '@agor-live/client';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCyclingProfileImageUrl } from './useCyclingProfileImage';
import { useTeammateProfileImageUrl } from './useTeammateProfileImageUrl';

vi.mock('./useCyclingProfileImage', () => ({ useCyclingProfileImageUrl: vi.fn() }));

function teammate(id: string, profileImageId?: string): Branch {
  return {
    branch_id: id,
    custom_context: {
      teammate: { kind: 'teammate', displayName: 'Ada', emoji: '🎨', profileImageId },
    },
  } as unknown as Branch;
}

describe('useTeammateProfileImageUrl', () => {
  beforeEach(() => {
    vi.mocked(useCyclingProfileImageUrl).mockReset();
    vi.mocked(useCyclingProfileImageUrl).mockReturnValue('blob:current');
  });

  it('cycles the teammate gallery with the projected primary first', () => {
    const { result } = renderHook(() =>
      useTeammateProfileImageUrl(teammate('branch-projected', 'image-projected'), 'small')
    );

    expect(result.current).toBe('blob:current');
    expect(useCyclingProfileImageUrl).toHaveBeenCalledWith(
      { type: 'teammate', id: 'branch-projected' },
      'image-projected',
      'small',
      true
    );
  });

  it('allows authoritative gallery metadata to supply a missing projection', () => {
    renderHook(() => useTeammateProfileImageUrl(teammate('branch-gallery'), 'large'));

    expect(useCyclingProfileImageUrl).toHaveBeenCalledWith(
      { type: 'teammate', id: 'branch-gallery' },
      undefined,
      'large',
      true
    );
  });
});
