import type { ProfileImage } from '@agor-live/client';
import { useCallback, useEffect, useState } from 'react';
import {
  fetchProfileIdentityModelBlob,
  generateProfileIdentityModel,
  refreshProfileIdentityModel,
} from './profileImageApi';
import { publishProfileImageMetadata } from './useProfileImageGallery';

const ACTIVE_STATUSES = new Set(['submitting', 'pending', 'in_progress']);

/** Reconciles provider state and exposes an authenticated object URL for a stored GLB. */
export function useProfileIdentityModel(image: ProfileImage | null | undefined, active = true) {
  const imageId = image?.image_id;
  const [current, setCurrent] = useState<ProfileImage | undefined>(image ?? undefined);
  const [modelUrl, setModelUrl] = useState<string>();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string>();
  const modelVersion = current?.identity_model?.updated_at;

  useEffect(() => {
    setCurrent((previous) => {
      if (!image) return undefined;
      if (previous?.image_id === image.image_id && previous.updated_at === image.updated_at) {
        return previous;
      }
      return image;
    });
    setError(undefined);
  }, [image]);

  useEffect(() => {
    if (!active || !imageId || !current?.identity_model?.model_available) {
      setModelUrl(undefined);
      return;
    }
    let mounted = true;
    let objectUrl: string | undefined;
    void fetchProfileIdentityModelBlob(imageId, modelVersion)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (mounted) setModelUrl(objectUrl);
      })
      .catch((nextError) => {
        if (mounted) {
          setError(nextError instanceof Error ? nextError.message : '3D model could not load');
        }
      });
    return () => {
      mounted = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [active, current?.identity_model?.model_available, imageId, modelVersion]);

  useEffect(() => {
    const status = current?.identity_model?.status;
    if (!active || !imageId || !status || !ACTIVE_STATUSES.has(status)) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const updated = await refreshProfileIdentityModel(imageId);
        if (!mounted) return;
        setCurrent(updated);
        publishProfileImageMetadata(updated);
        if (updated.identity_model && ACTIVE_STATUSES.has(updated.identity_model.status)) {
          timer = setTimeout(poll, 5_000);
        }
      } catch (nextError) {
        if (!mounted) return;
        setError(nextError instanceof Error ? nextError.message : '3D status could not refresh');
        timer = setTimeout(poll, 10_000);
      }
    };
    timer = setTimeout(poll, 1_500);
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [active, current?.identity_model?.status, imageId]);

  const generate = useCallback(async () => {
    if (!imageId) return;
    setGenerating(true);
    setError(undefined);
    try {
      const updated = await generateProfileIdentityModel(imageId);
      setCurrent(updated);
      publishProfileImageMetadata(updated);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '3D generation could not start');
      throw nextError;
    } finally {
      setGenerating(false);
    }
  }, [imageId]);

  return {
    image: current,
    identityModel: current?.identity_model,
    modelUrl,
    generating,
    error,
    generate,
  };
}
