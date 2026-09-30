import { describe, expect, it } from 'vitest';
import {
  eligibleEffects,
  MOSAIC_TILE_COUNT,
  PHOTO_EFFECTS,
  PhotoPlaylist,
  resolveScreensaverStyle,
  shufflePhotos,
  type TeammatePhoto,
} from './teammatePhotoSlides';

function photos(count: number): TeammatePhoto[] {
  return Array.from({ length: count }, (_, index) => ({
    imageId: `image-${index}`,
    teammateId: `teammate-${index % 3}`,
    teammateName: `Teammate ${index % 3}`,
  }));
}

/** Deterministic LCG so the playlist is reproducible. */
function seeded(seed = 7): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x80000000;
  };
}

describe('resolveScreensaverStyle', () => {
  it('defaults to teammate photos and keeps an explicit signal field', () => {
    expect(resolveScreensaverStyle(undefined)).toBe('teammate-photos');
    expect(resolveScreensaverStyle({ enabled: true })).toBe('teammate-photos');
    expect(resolveScreensaverStyle({ enabled: true, style: 'signal-field' })).toBe('signal-field');
    expect(
      resolveScreensaverStyle({ enabled: true, style: 'bogus' as unknown as 'signal-field' })
    ).toBe('teammate-photos');
  });
});

describe('eligibleEffects', () => {
  it('narrows to cross-fades under reduced motion', () => {
    expect(eligibleEffects(40, true)).toEqual(['fade']);
    expect(eligibleEffects(40, true, 'fade')).toEqual(['fade']);
  });

  it('needs enough photos for a mosaic and avoids repeating the previous effect', () => {
    expect(eligibleEffects(MOSAIC_TILE_COUNT - 1, false)).not.toContain('mosaic');
    expect(eligibleEffects(MOSAIC_TILE_COUNT, false)).toContain('mosaic');
    expect(eligibleEffects(40, false, 'slide')).not.toContain('slide');
  });
});

describe('shufflePhotos', () => {
  it('permutes without losing or duplicating items', () => {
    const input = photos(20);
    const shuffled = shufflePhotos(input, seeded());
    expect(shuffled).not.toBe(input);
    expect(shuffled.map((photo) => photo.imageId).sort()).toEqual(
      input.map((photo) => photo.imageId).sort()
    );
  });
});

describe('PhotoPlaylist', () => {
  it('returns nothing for an empty gallery', () => {
    expect(new PhotoPlaylist([], false).next()).toBeUndefined();
  });

  it('uses a variety of effects, never twice in a row, with distinct mosaic tiles', () => {
    const playlist = new PhotoPlaylist(photos(12), false, seeded());
    const slides = Array.from({ length: 60 }, () => playlist.next()!);
    const used = new Set(slides.map((slide) => slide.effect));
    expect(used.size).toBe(PHOTO_EFFECTS.length);
    for (let index = 1; index < slides.length; index += 1) {
      expect(slides[index].effect).not.toBe(slides[index - 1].effect);
      expect(slides[index].key).toBe(slides[index - 1].key + 1);
    }
    for (const slide of slides) {
      const ids = slide.photos.map((photo) => photo.imageId);
      expect(ids).toHaveLength(slide.effect === 'mosaic' ? MOSAIC_TILE_COUNT : 1);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('shows every photo once before any repeats', () => {
    const playlist = new PhotoPlaylist(photos(9), true, seeded(3));
    const shown = Array.from({ length: 9 }, () => playlist.next()!.photos[0].imageId);
    expect(new Set(shown).size).toBe(9);
  });

  it('only fades under reduced motion', () => {
    const playlist = new PhotoPlaylist(photos(12), true, seeded());
    for (let index = 0; index < 20; index += 1) expect(playlist.next()!.effect).toBe('fade');
  });
});
