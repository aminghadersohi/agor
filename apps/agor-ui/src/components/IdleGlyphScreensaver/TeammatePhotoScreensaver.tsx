// biome-ignore-all lint/plugin/noHardcodedColorLiteral: full-screen artwork uses a fixed dark palette outside Ant Design's themed surfaces

import { selectProfileImagesForTheme } from '@agor-live/client';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import {
  acquireProfileImageUrl,
  loadProfileImageGallery,
  releaseProfileImageUrl,
} from '../ProfileImage';
import { useProfileImageNetworkEnabled } from '../ProfileImage/ProfileImageNetworkContext';
import { PhotoPlaylist, type PhotoSlide, type TeammatePhoto } from './teammatePhotoSlides';

/** How long each slide holds before the next one starts entering. */
export const PHOTO_SLIDE_MS = 7_000;
/** Entrance duration; the outgoing slide stays mounted underneath until it ends. */
export const PHOTO_TRANSITION_MS = 1_400;
const GALLERY_CONCURRENCY = 4;
const MAX_PREPARE_ATTEMPTS = 3;
const VARIANT = 'large';

export interface ScreensaverTeammate {
  id: string;
  name: string;
  /** The teammate's active photo theme; only images carrying it are shown. */
  activeTheme?: string;
}

export interface TeammatePhotoScreensaverProps {
  teammates: ScreensaverTeammate[];
  reducedMotion: boolean;
  /** Called once when no teammate photo can be shown, so the host can fall back. */
  onUnavailable: () => void;
}

interface ShownSlide extends PhotoSlide {
  urls: Record<string, string>;
}

/** Every teammate's gallery, fetched a few at a time; unreadable galleries are skipped. */
export async function loadTeammatePhotos(
  teammates: ScreensaverTeammate[]
): Promise<TeammatePhoto[]> {
  const photos: TeammatePhoto[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < teammates.length) {
      const teammate = teammates[cursor++];
      try {
        const { images } = await loadProfileImageGallery({ type: 'teammate', id: teammate.id });
        for (const image of selectProfileImagesForTheme(images, teammate.activeTheme)) {
          photos.push({
            imageId: image.image_id,
            teammateId: teammate.id,
            teammateName: teammate.name,
          });
        }
      } catch {
        // A gallery the caller cannot view simply contributes no photos.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(GALLERY_CONCURRENCY, teammates.length) }, worker)
  );
  return photos;
}

async function decode(url: string): Promise<void> {
  if (typeof Image === 'undefined') return;
  const image = new Image();
  image.src = url;
  // Decoding before the entrance starts keeps Safari from flashing an empty frame.
  await image.decode?.().catch(() => undefined);
}

const STYLES = `
.agor-photo-saver-layer { position: absolute; inset: 0; overflow: hidden; background: #050608; }
.agor-photo-saver-backdrop {
  position: absolute; inset: -8%; width: 116%; height: 116%; object-fit: cover;
  filter: blur(36px) brightness(0.45) saturate(1.15);
}
.agor-photo-saver-frame {
  position: absolute; left: 50%; top: 50%;
  width: min(78vmin, 768px); height: min(78vmin, 768px);
  transform: translate(-50%, -50%);
  border-radius: 20px; overflow: hidden;
  box-shadow: 0 30px 90px rgba(0, 0, 0, 0.6);
}
.agor-photo-saver-frame img, .agor-photo-saver-tile img {
  display: block; width: 100%; height: 100%; object-fit: cover;
}
.agor-photo-saver-mosaic {
  position: absolute; inset: 0; display: grid; gap: 6px; padding: 6px;
  grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr));
}
.agor-photo-saver-tile { overflow: hidden; border-radius: 10px; }
.agor-photo-saver-fade { animation: agor-photo-fade var(--agor-transition) ease-out both; }
.agor-photo-saver-ken-burns {
  animation: agor-photo-fade var(--agor-transition) ease-out both,
    agor-photo-ken-burns var(--agor-hold) linear both;
}
.agor-photo-saver-slide { animation: agor-photo-slide var(--agor-transition) cubic-bezier(0.2, 0.7, 0.2, 1) both; }
.agor-photo-saver-blur { animation: agor-photo-blur var(--agor-transition) ease-out both; }
.agor-photo-saver-zoom { animation: agor-photo-zoom var(--agor-transition) cubic-bezier(0.2, 0.7, 0.2, 1) both; }
.agor-photo-saver-mosaic-layer { animation: agor-photo-fade 400ms ease-out both; }
.agor-photo-saver-mosaic-layer .agor-photo-saver-tile {
  animation: agor-photo-tile var(--agor-transition) cubic-bezier(0.2, 0.7, 0.2, 1) both;
}
@keyframes agor-photo-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes agor-photo-ken-burns {
  from { transform: scale(1) translate3d(0, 0, 0); }
  to { transform: scale(1.14) translate3d(calc(var(--agor-dir) * 3%), -2%, 0); }
}
@keyframes agor-photo-slide {
  from { transform: translate3d(calc(var(--agor-dir) * 100%), 0, 0); }
  to { transform: translate3d(0, 0, 0); }
}
@keyframes agor-photo-blur {
  from { opacity: 0; filter: blur(28px); transform: scale(1.04); }
  to { opacity: 1; filter: blur(0); transform: scale(1); }
}
@keyframes agor-photo-zoom {
  from { opacity: 0; transform: scale(1.3); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes agor-photo-tile {
  from { opacity: 0; transform: scale(0.82) rotate(calc(var(--agor-dir) * 3deg)); }
  to { opacity: 1; transform: scale(1) rotate(0); }
}
`;

function SlideLayer({ slide }: { slide: ShownSlide }) {
  const photos = slide.photos.filter((photo) => slide.urls[photo.imageId]);
  const style = {
    '--agor-dir': String(slide.direction),
    '--agor-transition': `${PHOTO_TRANSITION_MS}ms`,
    '--agor-hold': `${PHOTO_SLIDE_MS + PHOTO_TRANSITION_MS}ms`,
  } as CSSProperties;

  if (slide.effect === 'mosaic') {
    return (
      <div
        className="agor-photo-saver-layer agor-photo-saver-mosaic-layer"
        data-effect={slide.effect}
        style={style}
      >
        <div className="agor-photo-saver-mosaic">
          {photos.map((photo, index) => (
            <div
              key={photo.imageId}
              className="agor-photo-saver-tile"
              style={{ animationDelay: `${index * 180}ms` }}
            >
              <img src={slide.urls[photo.imageId]} alt={photo.teammateName} draggable={false} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const [photo] = photos;
  if (!photo) return null;
  const url = slide.urls[photo.imageId];
  return (
    <div
      className={`agor-photo-saver-layer agor-photo-saver-${slide.effect}`}
      data-effect={slide.effect}
      style={style}
    >
      <img className="agor-photo-saver-backdrop" src={url} alt="" aria-hidden draggable={false} />
      <div className="agor-photo-saver-frame">
        <img src={url} alt={photo.teammateName} draggable={false} />
      </div>
    </div>
  );
}

/**
 * Full-screen slideshow of teammate gallery photos. Loaded lazily by the idle
 * screensaver, so none of this ships until a screensaver first starts.
 */
export default function TeammatePhotoScreensaver({
  teammates,
  reducedMotion,
  onUnavailable,
}: TeammatePhotoScreensaverProps) {
  const networkEnabled = useProfileImageNetworkEnabled();
  const [slides, setSlides] = useState<ShownSlide[]>([]);
  // Captured once per activation: a teammate edit mid-show must not restart it.
  const teammatesRef = useRef(teammates);
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  useEffect(() => {
    if (!networkEnabled) {
      onUnavailableRef.current();
      return;
    }
    let cancelled = false;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    // Each prepared slide owns one reference per image it shows.
    const live = new Set<ShownSlide>();

    const release = (slide: ShownSlide) => {
      if (!live.delete(slide)) return;
      for (const imageId of Object.keys(slide.urls)) releaseProfileImageUrl(imageId, VARIANT);
    };

    const prepare = async (playlist: PhotoPlaylist): Promise<ShownSlide | undefined> => {
      for (let attempt = 0; attempt < MAX_PREPARE_ATTEMPTS && !cancelled; attempt += 1) {
        const slide = playlist.next();
        if (!slide) return undefined;
        const urls: Record<string, string> = {};
        await Promise.all(
          slide.photos.map(async (photo) => {
            try {
              const url = await acquireProfileImageUrl(photo.imageId, VARIANT);
              await decode(url);
              urls[photo.imageId] = url;
            } catch {
              releaseProfileImageUrl(photo.imageId, VARIANT);
            }
          })
        );
        const shown = { ...slide, urls };
        live.add(shown);
        if (cancelled) {
          release(shown);
          return undefined;
        }
        if (Object.keys(urls).length > 0) return shown;
        release(shown);
      }
      return undefined;
    };

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        holdTimer = setTimeout(resolve, ms);
      });

    const run = async () => {
      const photos = await loadTeammatePhotos(teammatesRef.current);
      if (cancelled) return;
      const playlist = new PhotoPlaylist(photos, reducedMotion);
      let current = await prepare(playlist);
      if (cancelled) return;
      if (!current) {
        onUnavailableRef.current();
        return;
      }
      setSlides([current]);
      // A single photo holds still; there is nothing to transition to.
      while (playlist.size > 1 && !cancelled) {
        const upcoming = prepare(playlist);
        await wait(PHOTO_SLIDE_MS);
        const next = await upcoming;
        if (cancelled || !next) return;
        const previous = current;
        current = next;
        setSlides([previous, next]);
        await wait(PHOTO_TRANSITION_MS);
        if (cancelled) return;
        release(previous);
        setSlides([next]);
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (holdTimer) clearTimeout(holdTimer);
      for (const slide of Array.from(live)) release(slide);
    };
  }, [networkEnabled, reducedMotion]);

  const current = slides[slides.length - 1];
  const names = current
    ? Array.from(new Set(current.photos.map((photo) => photo.teammateName))).join(' · ')
    : '';

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#050608' }}>
      <style>{STYLES}</style>
      {slides.map((slide) => (
        <SlideLayer key={slide.key} slide={slide} />
      ))}
      {names ? (
        <div
          aria-live="polite"
          style={{
            position: 'absolute',
            left: 24,
            right: 24,
            top: 'calc(20px + env(safe-area-inset-top, 0px))',
            color: 'rgba(255, 255, 255, 0.86)',
            font: '600 15px/1.3 system-ui, -apple-system, sans-serif',
            textShadow: '0 2px 12px rgba(0, 0, 0, 0.7)',
            pointerEvents: 'none',
          }}
        >
          {names}
        </div>
      ) : null}
    </div>
  );
}
