import type { ProfileImage, ProfileImageListResult } from '@agor-live/client';
import { useEffect, useMemo, useState } from 'react';
import { TOKENS_REFRESHED_EVENT } from '../../utils/singleFlightRefresh';
import { listProfileImages, type ProfileImageSubject } from './profileImageApi';

const galleryCache = new Map<string, ProfileImageListResult>();
const galleryRequests = new Map<string, Promise<ProfileImageListResult>>();

function subjectKey(subject: ProfileImageSubject): string {
  return `${subject.type}:${subject.id}`;
}

async function loadGallery(
  subject: ProfileImageSubject,
  force = false
): Promise<ProfileImageListResult> {
  const key = subjectKey(subject);
  if (!force) {
    const cached = galleryCache.get(key);
    if (cached) return cached;
    const pending = galleryRequests.get(key);
    if (pending) return pending;
  }

  const request = listProfileImages(subject)
    .then((result) => {
      galleryCache.set(key, result);
      return result;
    })
    .finally(() => galleryRequests.delete(key));
  galleryRequests.set(key, request);
  return request;
}

export function publishProfileImageGallery(
  subject: ProfileImageSubject,
  result: ProfileImageListResult
): void {
  galleryCache.set(subjectKey(subject), result);
  window.dispatchEvent(
    new CustomEvent('agor:profile-images-changed', { detail: { ...subject, result } })
  );
}

/** Update one cached image after a model-generation status transition. */
export function publishProfileImageMetadata(image: ProfileImage): void {
  for (const [key, result] of galleryCache) {
    const index = result.images.findIndex((candidate) => candidate.image_id === image.image_id);
    if (index < 0) continue;
    const images = result.images.slice();
    images[index] = image;
    const next = { ...result, images };
    galleryCache.set(key, next);
    const separator = key.indexOf(':');
    window.dispatchEvent(
      new CustomEvent('agor:profile-images-changed', {
        detail: {
          type: key.slice(0, separator),
          id: key.slice(separator + 1),
          result: next,
        },
      })
    );
  }
}

/** Shared, authenticated profile-gallery metadata with cross-surface invalidation. */
export function useProfileImageGallery(
  subject: ProfileImageSubject | null | undefined,
  enabled = true
): ProfileImage[] {
  const subjectType = subject?.type;
  const subjectId = subject?.id;
  const stableSubject = useMemo(
    () => (subjectType && subjectId ? { type: subjectType, id: subjectId } : undefined),
    [subjectId, subjectType]
  );
  const key = stableSubject ? subjectKey(stableSubject) : undefined;
  const [images, setImages] = useState<ProfileImage[]>(() =>
    key ? (galleryCache.get(key)?.images ?? []) : []
  );

  useEffect(() => {
    if (!stableSubject || !enabled) {
      setImages([]);
      return;
    }
    let active = true;
    const update = (result: ProfileImageListResult) => {
      if (active) setImages(result.images);
    };
    void loadGallery(stableSubject)
      .then(update)
      .catch(() => {
        if (active) setImages([]);
      });

    const onChanged = (event: Event) => {
      const detail = (
        event as CustomEvent<ProfileImageSubject & { result?: ProfileImageListResult }>
      ).detail;
      if (!detail || subjectKey(detail) !== subjectKey(stableSubject)) return;
      if (detail.result) update(detail.result);
      else
        void loadGallery(stableSubject, true)
          .then(update)
          .catch(() => undefined);
    };
    window.addEventListener('agor:profile-images-changed', onChanged);
    const onTokensRefreshed = () => {
      void loadGallery(stableSubject, true)
        .then(update)
        .catch(() => undefined);
    };
    window.addEventListener(TOKENS_REFRESHED_EVENT, onTokensRefreshed);
    return () => {
      active = false;
      window.removeEventListener('agor:profile-images-changed', onChanged);
      window.removeEventListener(TOKENS_REFRESHED_EVENT, onTokensRefreshed);
    };
  }, [enabled, stableSubject]);

  return useMemo(() => images.slice().sort((a, b) => a.position - b.position), [images]);
}
