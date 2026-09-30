import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  galleries: new Map<string, string[]>(),
  acquire: vi.fn(async (imageId: string) => `blob:${imageId}`),
  release: vi.fn(),
}));

vi.mock('../ProfileImage', () => ({
  loadProfileImageGallery: vi.fn(async ({ id }: { id: string }) => {
    const ids = mocks.galleries.get(id);
    if (!ids) throw new Error('forbidden');
    return { images: ids.map((image_id) => ({ image_id })), max_images: 100 };
  }),
  acquireProfileImageUrl: mocks.acquire,
  releaseProfileImageUrl: mocks.release,
}));

import TeammatePhotoScreensaver, {
  loadTeammatePhotos,
  PHOTO_SLIDE_MS,
  PHOTO_TRANSITION_MS,
} from './TeammatePhotoScreensaver';

const TEAMMATES = [
  { id: 'lagertha', name: 'Lagertha' },
  { id: 'ragnar', name: 'Ragnar' },
  { id: 'hidden', name: 'Hidden' },
];

async function flush() {
  for (let index = 0; index < 10; index += 1) await act(async () => {});
}

describe('TeammatePhotoScreensaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.galleries.clear();
    mocks.galleries.set('lagertha', ['l1', 'l2']);
    mocks.galleries.set('ragnar', ['r1']);
    mocks.acquire.mockClear();
    mocks.release.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collects photos from every readable teammate gallery', async () => {
    const photos = await loadTeammatePhotos(TEAMMATES);
    expect(photos.map((photo) => photo.imageId).sort()).toEqual(['l1', 'l2', 'r1']);
    expect(photos.find((photo) => photo.imageId === 'r1')?.teammateName).toBe('Ragnar');
  });

  it('shows teammate photos, advances, and releases every image on unmount', async () => {
    const onUnavailable = vi.fn();
    const { unmount } = render(
      <TeammatePhotoScreensaver teammates={TEAMMATES} reducedMotion onUnavailable={onUnavailable} />
    );
    await flush();

    const first = screen.getAllByRole('img').map((image) => image.getAttribute('src'));
    expect(first[0]).toMatch(/^blob:/);
    expect(document.querySelector('[data-effect]')?.getAttribute('data-effect')).toBe('fade');

    await act(async () => vi.advanceTimersByTime(PHOTO_SLIDE_MS));
    await flush();
    // Incoming slide stacks over the outgoing one during the transition.
    expect(document.querySelectorAll('[data-effect]')).toHaveLength(2);

    await act(async () => vi.advanceTimersByTime(PHOTO_TRANSITION_MS));
    await flush();
    expect(document.querySelectorAll('[data-effect]')).toHaveLength(1);

    unmount();
    expect(mocks.release.mock.calls.length).toBe(mocks.acquire.mock.calls.length);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('reports when no teammate has a photo', async () => {
    mocks.galleries.clear();
    const onUnavailable = vi.fn();
    render(
      <TeammatePhotoScreensaver
        teammates={TEAMMATES}
        reducedMotion={false}
        onUnavailable={onUnavailable}
      />
    );
    await flush();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
