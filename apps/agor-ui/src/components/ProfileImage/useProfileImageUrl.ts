import type { ProfileImageVariant } from '@agor-live/client';
import { useEffect, useState } from 'react';
import { fetchProfileImageBlob } from './profileImageApi';

interface CachedImage {
  url?: string;
  promise?: Promise<string>;
  references: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const imageCache = new Map<string, CachedImage>();

function cacheKey(imageId: string, variant: ProfileImageVariant): string {
  return `${imageId}:${variant}`;
}

async function acquireImageUrl(imageId: string, variant: ProfileImageVariant): Promise<string> {
  const key = cacheKey(imageId, variant);
  let entry = imageCache.get(key);
  if (!entry) {
    entry = { references: 0 };
    imageCache.set(key, entry);
  }
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
  entry.references += 1;
  if (entry.url) return entry.url;
  if (!entry.promise) {
    entry.promise = fetchProfileImageBlob(imageId, variant).then((blob) => {
      const url = URL.createObjectURL(blob);
      const current = imageCache.get(key);
      if (current) {
        current.url = url;
        current.promise = undefined;
      }
      return url;
    });
  }
  try {
    return await entry.promise;
  } catch (error) {
    entry.promise = undefined;
    throw error;
  }
}

function releaseImageUrl(imageId: string, variant: ProfileImageVariant): void {
  const key = cacheKey(imageId, variant);
  const entry = imageCache.get(key);
  if (!entry) return;
  entry.references = Math.max(0, entry.references - 1);
  if (entry.references > 0) return;
  entry.cleanupTimer = setTimeout(() => {
    const current = imageCache.get(key);
    if (!current || current.references > 0) return;
    if (current.url) URL.revokeObjectURL(current.url);
    imageCache.delete(key);
  }, 30_000);
}

/** Authenticated object URL for a private profile-image variant. */
export function useProfileImageUrl(
  imageId: string | null | undefined,
  variant: ProfileImageVariant
): string | undefined {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (!imageId) {
      setUrl(undefined);
      return;
    }
    let active = true;
    setUrl(undefined);
    void acquireImageUrl(imageId, variant)
      .then((nextUrl) => {
        if (active) setUrl(nextUrl);
      })
      .catch(() => {
        if (active) setUrl(undefined);
      });
    return () => {
      active = false;
      releaseImageUrl(imageId, variant);
    };
  }, [imageId, variant]);

  return url;
}
