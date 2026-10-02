import type {
  ProfileImage,
  ProfileImageListResult,
  ProfileImagePatch,
  ProfileImageSubjectType,
  ProfileImageVariant,
} from '@agor-live/client';
import { createRestClient } from '@agor-live/client';
import { getDaemonUrl } from '../../config/daemon';
import { getAgorAccessToken, getAuthHeaders } from '../../utils/authHeaders';
import { refreshTokensSingleFlight } from '../../utils/singleFlightRefresh';
import { getStoredRefreshToken } from '../../utils/tokenRefresh';

export interface ProfileImageSubject {
  type: ProfileImageSubjectType;
  id: string;
}

function endpoint(path = ''): string {
  return `${getDaemonUrl().replace(/\/$/, '')}/profile-images${path}`;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
  } catch {
    // Fall through to the status-based message when the daemon returned no JSON.
  }
  return `Profile image request failed (${response.status})`;
}

async function assertOk(response: Response): Promise<Response> {
  if (!response.ok) throw new Error(await errorMessage(response));
  return response;
}

async function profileFetch(
  url: string,
  init: RequestInit = {},
  content: 'json' | 'form' = 'json'
): Promise<Response> {
  const execute = () => {
    const token = getAgorAccessToken();
    const headers: HeadersInit =
      content === 'json' ? getAuthHeaders() : token ? { Authorization: `Bearer ${token}` } : {};
    return fetch(url, { ...init, headers });
  };

  const first = await execute();
  if (first.status !== 401) return first;

  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) return first;
  await refreshTokensSingleFlight(await createRestClient(getDaemonUrl()), refreshToken);
  return execute();
}

export async function listProfileImages(
  subject: ProfileImageSubject
): Promise<ProfileImageListResult> {
  const query = new URLSearchParams({ subjectType: subject.type, subjectId: subject.id });
  return listResult(await profileFetch(`${endpoint()}?${query}`));
}

export interface UploadProfileImageOptions {
  /** Label the new image with this theme. */
  theme?: string;
  /** Called with 0..1 as the request body is sent; selecting it switches to XHR. */
  onProgress?: (fraction: number) => void;
}

function uploadForm(subject: ProfileImageSubject, file: File, theme?: string): FormData {
  const form = new FormData();
  form.append('subjectType', subject.type);
  form.append('subjectId', subject.id);
  if (theme) form.append('theme', theme);
  form.append('image', file);
  return form;
}

/** `fetch` cannot report upload progress, so progress-aware uploads go through XHR. */
function sendUploadWithProgress(
  form: FormData,
  onProgress: (fraction: number) => void
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', endpoint());
    const token = getAgorAccessToken();
    if (token) request.setRequestHeader('Authorization', `Bearer ${token}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => resolve({ status: request.status, body: request.responseText });
    request.onerror = () => reject(new Error('Upload failed: network error'));
    request.onabort = () => reject(new Error('Upload cancelled'));
    request.send(form);
  });
}

export async function uploadProfileImage(
  subject: ProfileImageSubject,
  file: File,
  options: UploadProfileImageOptions = {}
): Promise<ProfileImage> {
  const { theme, onProgress } = options;
  if (!onProgress) {
    const response = await profileFetch(
      endpoint(),
      { method: 'POST', body: uploadForm(subject, file, theme) },
      'form'
    );
    return (await (await assertOk(response)).json()) as ProfileImage;
  }

  let result = await sendUploadWithProgress(uploadForm(subject, file, theme), onProgress);
  if (result.status === 401) {
    const refreshToken = getStoredRefreshToken();
    if (refreshToken) {
      await refreshTokensSingleFlight(await createRestClient(getDaemonUrl()), refreshToken);
      result = await sendUploadWithProgress(uploadForm(subject, file, theme), onProgress);
    }
  }
  if (result.status < 200 || result.status >= 300) {
    let message = `Profile image request failed (${result.status})`;
    try {
      const body = JSON.parse(result.body) as { message?: unknown };
      if (typeof body.message === 'string' && body.message.trim()) message = body.message;
    } catch {
      // Keep the status-based message when the daemon returned no JSON.
    }
    throw new Error(message);
  }
  onProgress(1);
  return JSON.parse(result.body) as ProfileImage;
}

export async function patchProfileImage(
  imageId: string,
  patch: ProfileImagePatch
): Promise<ProfileImage> {
  const response = await profileFetch(endpoint(`/${encodeURIComponent(imageId)}`), {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return (await (await assertOk(response)).json()) as ProfileImage;
}

export async function deleteProfileImage(imageId: string): Promise<void> {
  const response = await profileFetch(endpoint(`/${encodeURIComponent(imageId)}`), {
    method: 'DELETE',
  });
  await assertOk(response);
}

export async function fetchProfileImageBlob(
  imageId: string,
  variant: ProfileImageVariant
): Promise<Blob> {
  const response = await profileFetch(
    endpoint(`/${encodeURIComponent(imageId)}/${encodeURIComponent(variant)}`)
  );
  return (await assertOk(response)).blob();
}

async function listResult(response: Response): Promise<ProfileImageListResult> {
  const result = (await (await assertOk(response)).json()) as Partial<ProfileImageListResult>;
  if (!Array.isArray(result.images) || typeof result.max_images !== 'number') {
    throw new Error('Profile image response was invalid');
  }
  return result as ProfileImageListResult;
}

/** Put `imageIds` first in gallery order; the rest keep their order after them. */
export async function reorderProfileImages(
  subject: ProfileImageSubject,
  imageIds: string[]
): Promise<ProfileImageListResult> {
  return listResult(
    await profileFetch(endpoint('/order'), {
      method: 'PUT',
      body: JSON.stringify({ subjectType: subject.type, subjectId: subject.id, imageIds }),
    })
  );
}

/** Delete several images at once. */
export async function bulkDeleteProfileImages(
  subject: ProfileImageSubject,
  imageIds: string[]
): Promise<ProfileImageListResult> {
  return listResult(
    await profileFetch(endpoint('/bulk'), {
      method: 'POST',
      body: JSON.stringify({
        action: 'delete',
        subjectType: subject.type,
        subjectId: subject.id,
        imageIds,
      }),
    })
  );
}

/** Set (or with null clear) the theme of several images at once. */
export async function bulkSetProfileImageTheme(
  subject: ProfileImageSubject,
  imageIds: string[],
  theme: string | null
): Promise<ProfileImageListResult> {
  return listResult(
    await profileFetch(endpoint('/bulk'), {
      method: 'POST',
      body: JSON.stringify({
        action: 'set-theme',
        subjectType: subject.type,
        subjectId: subject.id,
        imageIds,
        theme,
      }),
    })
  );
}

/** Restrict a teammate's photo surfaces to one theme; null shows the whole gallery. */
export async function setTeammateActiveTheme(
  teammateId: string,
  theme: string | null
): Promise<{ active_theme: string | null }> {
  const response = await profileFetch(endpoint('/active-theme'), {
    method: 'PUT',
    body: JSON.stringify({ subjectId: teammateId, theme }),
  });
  return (await (await assertOk(response)).json()) as { active_theme: string | null };
}
