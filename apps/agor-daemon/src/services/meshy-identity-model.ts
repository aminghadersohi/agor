import { createPinnedFetch } from '@agor/core/utils/pinned-fetch';

const MESHY_API_ORIGIN = 'https://api.meshy.ai';
const MESHY_TASK_PATH = '/openapi/v1/image-to-3d';
const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;
export const MAX_IDENTITY_MODEL_BYTES = 64 * 1024 * 1024;

export type MeshyIdentityTaskStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELED';

export interface MeshyIdentityTask {
  id: string;
  status: MeshyIdentityTaskStatus;
  progress: number;
  modelUrl?: string;
}

interface MeshyTaskResponse {
  id?: unknown;
  status?: unknown;
  progress?: unknown;
  model_urls?: { glb?: unknown };
}

interface MeshyIdentityModelDependencies {
  apiFetch?: typeof fetch;
  modelFetch?: typeof fetch;
}

function providerError(status: number): Error {
  if (status === 401) return new Error('Meshy API credentials are invalid');
  if (status === 402) return new Error('Meshy credits are required to generate this model');
  if (status === 429) return new Error('Meshy is rate limiting 3D generation; try again shortly');
  return new Error('The 3D generation provider could not complete the request');
}

function parseTask(payload: MeshyTaskResponse): MeshyIdentityTask {
  const allowed = new Set<MeshyIdentityTaskStatus>([
    'PENDING',
    'IN_PROGRESS',
    'SUCCEEDED',
    'FAILED',
    'CANCELED',
  ]);
  if (typeof payload.id !== 'string' || !allowed.has(payload.status as MeshyIdentityTaskStatus)) {
    throw new Error('Meshy returned an invalid task response');
  }
  return {
    id: payload.id,
    status: payload.status as MeshyIdentityTaskStatus,
    progress:
      typeof payload.progress === 'number'
        ? Math.max(0, Math.min(100, Math.round(payload.progress)))
        : 0,
    ...(typeof payload.model_urls?.glb === 'string' ? { modelUrl: payload.model_urls.glb } : {}),
  };
}

/** Server-only Meshy client. API keys and signed provider URLs never reach the UI. */
export class MeshyIdentityModelClient {
  private readonly apiFetch: typeof fetch;
  private readonly modelFetch: typeof fetch;

  constructor(
    private readonly apiKey: string,
    dependencies: MeshyIdentityModelDependencies = {}
  ) {
    if (!apiKey.trim()) throw new Error('MESHY_API_KEY is not configured');
    this.apiFetch =
      dependencies.apiFetch ??
      (createPinnedFetch({
        timeoutMs: 30_000,
        maxBytes: MAX_PROVIDER_RESPONSE_BYTES,
      }) as typeof fetch);
    this.modelFetch =
      dependencies.modelFetch ??
      (createPinnedFetch({
        timeoutMs: 120_000,
        maxBytes: MAX_IDENTITY_MODEL_BYTES,
      }) as typeof fetch);
  }

  async create(imagePng: Buffer): Promise<string> {
    const response = await this.apiFetch(`${MESHY_API_ORIGIN}${MESHY_TASK_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image_url: `data:image/png;base64,${imagePng.toString('base64')}`,
        ai_model: 'latest',
        model_type: 'standard',
        should_texture: true,
        enable_pbr: true,
        image_enhancement: true,
        moderation: true,
        target_formats: ['glb'],
      }),
    });
    if (!response.ok) throw providerError(response.status);
    const payload = (await response.json()) as { result?: unknown };
    if (typeof payload.result !== 'string' || !payload.result.trim()) {
      throw new Error('Meshy did not return a generation task');
    }
    return payload.result;
  }

  async get(taskId: string): Promise<MeshyIdentityTask> {
    const response = await this.apiFetch(
      `${MESHY_API_ORIGIN}${MESHY_TASK_PATH}/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } }
    );
    if (!response.ok) throw providerError(response.status);
    return parseTask((await response.json()) as MeshyTaskResponse);
  }

  async delete(taskId: string): Promise<void> {
    const response = await this.apiFetch(
      `${MESHY_API_ORIGIN}${MESHY_TASK_PATH}/${encodeURIComponent(taskId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      }
    );
    if (!response.ok && response.status !== 404) throw providerError(response.status);
  }

  async downloadGlb(modelUrl: string): Promise<Buffer> {
    const url = new URL(modelUrl);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.meshy.ai')) {
      throw new Error('Meshy returned an invalid model download location');
    }
    const response = await this.modelFetch(url.toString());
    if (!response.ok) throw new Error('The generated model could not be downloaded');
    const model = Buffer.from(await response.arrayBuffer());
    if (model.byteLength < 12 || model.subarray(0, 4).toString('ascii') !== 'glTF') {
      throw new Error('Meshy returned an invalid GLB model');
    }
    return model;
  }
}
