import type { ProfileImage, ProfileImageID, ProfileImageVariant } from '@agor-live/client';
import { selectProfileImagesForTheme } from '@agor-live/client';
import { useEffect, useMemo, useState } from 'react';
import type { ProfileImageSubject } from './profileImageApi';
import { useProfileImageGallery } from './useProfileImageGallery';
import { useProfileImageUrl } from './useProfileImageUrl';

/** Slow, ambient rotation so identity photos never feel like animated badges. */
export const PROFILE_IMAGE_CYCLE_INTERVAL_MS = 30_000;

/**
 * Gallery ids in rotation order, primary first. With an `activeTheme` only
 * images carrying it take part (the whole gallery when none do), and a
 * projected primary outside that set yields to the first themed image.
 */
export function orderedProfileImageIds(
  images: ProfileImage[],
  projectedPrimaryId?: ProfileImageID | null,
  activeTheme?: string | null
): ProfileImageID[] {
  const sortedImages = selectProfileImagesForTheme(
    images.slice().sort((a, b) => a.position - b.position),
    activeTheme
  );
  const galleryPrimary =
    sortedImages.find((image) => image.is_primary)?.image_id ?? sortedImages[0]?.image_id;
  const projectedPrimaryIsCurrent =
    projectedPrimaryId &&
    (sortedImages.length === 0 ||
      sortedImages.some((image) => image.image_id === projectedPrimaryId));
  const primaryId = projectedPrimaryIsCurrent ? projectedPrimaryId : galleryPrimary;
  const ordered = primaryId
    ? [primaryId, ...sortedImages.map((image) => image.image_id)]
    : sortedImages.map((image) => image.image_id);
  return [...new Set(ordered)];
}

/**
 * Selects the current gallery image while respecting reduced motion and page visibility.
 * The projected primary always appears first, including while gallery metadata is loading.
 */
export function useCyclingProfileImageId(
  images: ProfileImage[],
  projectedPrimaryId?: ProfileImageID | null,
  enabled = true,
  activeTheme?: string | null
): ProfileImageID | undefined {
  const imageIds = useMemo(
    () => orderedProfileImageIds(images, projectedPrimaryId, activeTheme),
    [images, projectedPrimaryId, activeTheme]
  );
  const signature = imageIds.join(':');
  const [rotation, setRotation] = useState({ signature, index: 0 });
  const currentIndex =
    imageIds.length > 0 && rotation.signature === signature ? rotation.index % imageIds.length : 0;

  useEffect(() => {
    if (!enabled || imageIds.length < 2 || typeof window === 'undefined') return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setInterval> | undefined;

    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      if (reducedMotion.matches || document.visibilityState !== 'visible') return;
      timer = setInterval(() => {
        setRotation((current) => ({
          signature,
          index: current.signature === signature ? (current.index + 1) % imageIds.length : 1,
        }));
      }, PROFILE_IMAGE_CYCLE_INTERVAL_MS);
    };
    const onMotionChange = () => {
      if (reducedMotion.matches) {
        stop();
        setRotation({ signature, index: 0 });
      } else {
        start();
      }
    };

    start();
    document.addEventListener('visibilitychange', start);
    if (typeof reducedMotion.addEventListener === 'function') {
      reducedMotion.addEventListener('change', onMotionChange);
    } else {
      reducedMotion.addListener(onMotionChange);
    }
    return () => {
      stop();
      document.removeEventListener('visibilitychange', start);
      if (typeof reducedMotion.removeEventListener === 'function') {
        reducedMotion.removeEventListener('change', onMotionChange);
      } else {
        reducedMotion.removeListener(onMotionChange);
      }
    };
  }, [enabled, imageIds.length, signature]);

  return imageIds[currentIndex];
}

/** Authenticated rotating URL for a user, teammate, or board gallery. */
export function useCyclingProfileImageUrl(
  subject: ProfileImageSubject | null | undefined,
  projectedPrimaryId: ProfileImageID | null | undefined,
  variant: ProfileImageVariant,
  enabled = true,
  activeTheme?: string | null
): string | undefined {
  const images = useProfileImageGallery(subject, Boolean(subject && enabled));
  const imageId = useCyclingProfileImageId(
    images,
    enabled ? projectedPrimaryId : undefined,
    enabled,
    activeTheme
  );
  const continuityKey = subject ? `${subject.type}:${subject.id}` : undefined;
  return useProfileImageUrl(imageId, variant, continuityKey);
}
