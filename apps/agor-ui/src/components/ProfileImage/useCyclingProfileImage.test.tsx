import type { ProfileImage, ProfileImageID } from '@agor-live/client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  orderedProfileImageIds,
  PROFILE_IMAGE_CYCLE_INTERVAL_MS,
  useCyclingProfileImageId,
} from './useCyclingProfileImage';

function image(id: string, position: number, isPrimary = false): ProfileImage {
  return {
    image_id: id,
    subject_type: 'teammate',
    subject_id: 'branch-1',
    created_by: 'user-1',
    original_name: `${id}.webp`,
    position,
    is_primary: isPrimary,
    small_width: 128,
    small_height: 128,
    large_width: 768,
    large_height: 768,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as ProfileImage;
}

function mediaQuery(matches: boolean): MediaQueryList {
  return {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
}

describe('profile image cycling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'matchMedia').mockReturnValue(mediaQuery(false));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('orders the projected primary first and removes duplicates', () => {
    const images = [image('second', 1), image('primary', 0, true)];
    expect(orderedProfileImageIds(images, 'second' as ProfileImageID)).toEqual([
      'second',
      'primary',
    ]);
  });

  it('uses authoritative gallery metadata when a projected primary is stale', () => {
    const images = [image('second', 1), image('primary', 0, true)];
    expect(orderedProfileImageIds(images, 'removed' as ProfileImageID)).toEqual([
      'primary',
      'second',
    ]);
  });

  it('cycles every configured image and returns to the primary', () => {
    const images = [image('primary', 0, true), image('second', 1), image('third', 2)];
    const { result } = renderHook(() => useCyclingProfileImageId(images));

    expect(result.current).toBe('primary');
    act(() => vi.advanceTimersByTime(PROFILE_IMAGE_CYCLE_INTERVAL_MS));
    expect(result.current).toBe('second');
    act(() => vi.advanceTimersByTime(PROFILE_IMAGE_CYCLE_INTERVAL_MS));
    expect(result.current).toBe('third');
    act(() => vi.advanceTimersByTime(PROFILE_IMAGE_CYCLE_INTERVAL_MS));
    expect(result.current).toBe('primary');
  });

  it('keeps the primary fixed when reduced motion is requested', () => {
    vi.mocked(window.matchMedia).mockReturnValue(mediaQuery(true));
    const images = [image('primary', 0, true), image('second', 1)];
    const { result } = renderHook(() => useCyclingProfileImageId(images));

    act(() => vi.advanceTimersByTime(PROFILE_IMAGE_CYCLE_INTERVAL_MS * 2));
    expect(result.current).toBe('primary');
  });
});
