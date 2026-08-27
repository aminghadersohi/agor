import type { McpServer } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repositoryMocks = vi.hoisted(() => ({
  listForSubject: vi.fn(),
  findById: vi.fn(),
  readVariant: vi.fn(),
}));

vi.mock('@agor/core/db', () => ({
  ProfileImageRepository: class ProfileImageRepository {
    listForSubject = repositoryMocks.listForSubject;
    findById = repositoryMocks.findById;
    readVariant = repositoryMocks.readVariant;
  },
}));

const { registerProfileImageTools } = await import('./profile-images.js');

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function captureHandler(
  toolName: string,
  ctx: Parameters<typeof registerProfileImageTools>[1]
): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (name: string, _config: unknown, candidate: ToolHandler) => {
      if (name === toolName) handler = candidate;
    },
  } as unknown as McpServer;
  registerProfileImageTools(fakeServer, ctx);
  if (!handler) throw new Error(`${toolName} was not registered`);
  return handler;
}

function makeContext(options?: {
  userGet?: ReturnType<typeof vi.fn>;
  branchGet?: ReturnType<typeof vi.fn>;
}) {
  const userGet = options?.userGet ?? vi.fn(async () => ({ user_id: 'user-2' }));
  const branchGet =
    options?.branchGet ??
    vi.fn(async () => ({
      branch_id: 'branch-1',
      custom_context: { teammate: { kind: 'teammate', displayName: 'Designer' } },
    }));
  const baseServiceParams = {
    authenticated: true,
    provider: 'mcp',
    tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
    user: { user_id: 'user-1', role: 'member' },
  };
  return {
    app: {
      service: (name: string) => {
        if (name === 'users') return { get: userGet };
        if (name === 'branches') return { get: branchGet };
        throw new Error(`Unexpected service: ${name}`);
      },
    },
    db: {},
    userId: 'user-1',
    authenticatedUser: baseServiceParams.user,
    baseServiceParams,
  } as unknown as Parameters<typeof registerProfileImageTools>[1];
}

const image = {
  image_id: 'image-1',
  subject_type: 'teammate',
  subject_id: 'branch-1',
  created_by: 'user-1',
  original_name: 'portrait.png',
  alt_text: 'Teammate portrait',
  position: 0,
  is_primary: true,
  small_width: 96,
  small_height: 96,
  large_width: 768,
  large_height: 512,
  created_at: '2026-08-26T00:00:00.000Z',
  updated_at: '2026-08-26T00:00:00.000Z',
};

describe('profile-image MCP tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists metadata only after the authenticated subject lookup succeeds', async () => {
    repositoryMocks.listForSubject.mockResolvedValue([image]);
    const ctx = makeContext();
    const result = (await captureHandler(
      'agor_profile_images_list',
      ctx
    )({
      subjectType: 'teammate',
      subjectId: 'branch-1',
    })) as { content: Array<{ text: string }> };

    expect(ctx.app.service('branches').get).toHaveBeenCalledWith('branch-1', ctx.baseServiceParams);
    expect(repositoryMocks.listForSubject).toHaveBeenCalledWith('tenant-a', {
      type: 'teammate',
      id: 'branch-1',
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      images: [{ image_id: 'image-1', is_primary: true }],
    });
  });

  it('returns a processed variant as MCP image content without storage details', async () => {
    repositoryMocks.findById.mockResolvedValue(image);
    repositoryMocks.readVariant.mockResolvedValue({
      image,
      data: Buffer.from('processed-pixels'),
      contentType: 'image/webp',
    });
    const result = (await captureHandler(
      'agor_profile_images_get',
      makeContext()
    )({
      imageId: 'image-1',
      variant: 'small',
    })) as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    };

    expect(JSON.parse(result.content[0].text ?? '{}')).toMatchObject({
      image_id: 'image-1',
      variant: 'small',
      width: 96,
      height: 96,
    });
    expect(result.content[1]).toEqual({
      type: 'image',
      data: Buffer.from('processed-pixels').toString('base64'),
      mimeType: 'image/webp',
    });
    expect(JSON.stringify(result)).not.toContain('path');
    expect(JSON.stringify(result)).not.toContain('original_data');
  });

  it('does not read pixels when branch authorization rejects the teammate', async () => {
    repositoryMocks.findById.mockResolvedValue(image);
    const ctx = makeContext({
      branchGet: vi.fn(async () => {
        throw new Error('forbidden');
      }),
    });

    await expect(
      captureHandler('agor_profile_images_get', ctx)({ imageId: 'image-1' })
    ).rejects.toThrow('Profile unavailable');
    expect(repositoryMocks.readVariant).not.toHaveBeenCalled();
  });

  it('rejects ordinary branches even when they are otherwise visible', async () => {
    repositoryMocks.findById.mockResolvedValue(image);
    const ctx = makeContext({
      branchGet: vi.fn(async () => ({ branch_id: 'branch-1', custom_context: {} })),
    });

    await expect(
      captureHandler('agor_profile_images_get', ctx)({ imageId: 'image-1' })
    ).rejects.toThrow('Profile unavailable');
    expect(repositoryMocks.readVariant).not.toHaveBeenCalled();
  });
});
