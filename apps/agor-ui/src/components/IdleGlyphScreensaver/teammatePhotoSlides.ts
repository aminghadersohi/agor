import type { ScreensaverPreferences, ScreensaverStyle } from '@agor-live/client';

export const DEFAULT_SCREENSAVER_STYLE: ScreensaverStyle = 'teammate-photos';

/** Stored style, defaulting to teammate photos for unset or unknown values. */
export function resolveScreensaverStyle(preferences?: ScreensaverPreferences): ScreensaverStyle {
  return preferences?.style === 'signal-field' ? 'signal-field' : DEFAULT_SCREENSAVER_STYLE;
}

/**
 * Entrance effects for one slide. Every effect but `fade` moves pixels, so a
 * reduced-motion request narrows the rotation to `fade` alone.
 */
export const PHOTO_EFFECTS = ['fade', 'ken-burns', 'slide', 'blur', 'zoom', 'mosaic'] as const;
export type PhotoEffect = (typeof PHOTO_EFFECTS)[number];

/** Tiles in a mosaic slide; it needs at least this many distinct photos. */
export const MOSAIC_TILE_COUNT = 4;

export interface TeammatePhoto {
  imageId: string;
  teammateId: string;
  teammateName: string;
}

export interface PhotoSlide {
  /** Unique per slide so React remounts it and replays its entrance. */
  key: number;
  effect: PhotoEffect;
  photos: TeammatePhoto[];
  /** Direction variant for directional effects: -1 or 1. */
  direction: -1 | 1;
}

type Random = () => number;

export function shufflePhotos<T>(items: readonly T[], random: Random = Math.random): T[] {
  const result = items.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

/** Effects eligible for the next slide, never repeating the previous one when avoidable. */
export function eligibleEffects(
  photoCount: number,
  reducedMotion: boolean,
  previous?: PhotoEffect
): PhotoEffect[] {
  if (reducedMotion) return ['fade'];
  const candidates = PHOTO_EFFECTS.filter(
    (effect) => effect !== 'mosaic' || photoCount >= MOSAIC_TILE_COUNT
  );
  const fresh = candidates.filter((effect) => effect !== previous);
  return fresh.length > 0 ? fresh : candidates;
}

/**
 * Walks a shuffled deck of photos, reshuffling once it is exhausted, and
 * assigns each slide an effect. Pure apart from the injected random source.
 */
export class PhotoPlaylist {
  private deck: TeammatePhoto[] = [];
  private nextKey = 0;
  private previousEffect?: PhotoEffect;
  private readonly photos: readonly TeammatePhoto[];
  private readonly reducedMotion: boolean;
  private readonly random: Random;

  constructor(
    photos: readonly TeammatePhoto[],
    reducedMotion: boolean,
    random: Random = Math.random
  ) {
    this.photos = photos;
    this.reducedMotion = reducedMotion;
    this.random = random;
  }

  get size(): number {
    return this.photos.length;
  }

  private draw(): TeammatePhoto {
    if (this.deck.length === 0) this.deck = shufflePhotos(this.photos, this.random);
    return this.deck.pop()!;
  }

  next(): PhotoSlide | undefined {
    if (this.photos.length === 0) return undefined;
    const effects = eligibleEffects(this.photos.length, this.reducedMotion, this.previousEffect);
    const effect = effects[Math.floor(this.random() * effects.length)] ?? 'fade';
    this.previousEffect = effect;
    const count = effect === 'mosaic' ? MOSAIC_TILE_COUNT : 1;
    const photos: TeammatePhoto[] = [];
    while (photos.length < count) {
      const photo = this.draw();
      // A deck boundary can repeat a photo inside one mosaic; skip it.
      if (!photos.some((existing) => existing.imageId === photo.imageId)) photos.push(photo);
    }
    return {
      key: this.nextKey++,
      effect,
      photos,
      direction: this.random() < 0.5 ? -1 : 1,
    };
  }
}
