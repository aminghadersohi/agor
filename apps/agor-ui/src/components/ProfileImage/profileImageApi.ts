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
  const response = await profileFetch(`${endpoint()}?${query}`);
  const result = (await (await assertOk(response)).json()) as Partial<ProfileImageListResult>;
  if (!Array.isArray(result.images) || typeof result.max_images !== 'number') {
    throw new Error('Profile image response was invalid');
  }
  return result as ProfileImageListResult;
}

export async function uploadProfileImage(
  subject: ProfileImageSubject,
  file: File
): Promise<ProfileImage> {
  const form = new FormData();
  form.append('subjectType', subject.type);
  form.append('subjectId', subject.id);
  form.append('image', file);
  const response = await profileFetch(
    endpoint(),
    {
      method: 'POST',
      body: form,
    },
    'form'
  );
  return (await (await assertOk(response)).json()) as ProfileImage;
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
