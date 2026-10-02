import type { McpServer } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

const managerMocks = vi.hoisted(() => ({
  upload: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setActiveTheme: vi.fn(),
}));

vi.mock('../../utils/profile-image-management.js', () => ({
  getProfileImageManager: (app: { get: (key: string) => unknown }) =>
    app.get('profileImageManager'),
  profileImageCallerFromParams: (
    params: { tenant?: { tenant_id: string }; user: { user_id: string } },
    fallbackTenantId: string
  ) => ({
    params,
    tenantId: params.tenant?.tenant_id ?? fallbackTenantId,
    userId: params.user.user_id,
  }),
}));

vi.mock('../resolve-ids.js', () => ({
  resolveBranchId: async (_ctx: unknown, id: string) => `resolved-${id}`,
}));

const { registerProfileImageTools } = await import('./users.js');
const { FILE_READ_MIN_RESPONSE_BYTES } = await import('../../services/file.js');

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
type ToolConfig = { inputSchema: z.ZodType };

function capture(toolName: string, ctx: Parameters<typeof registerProfileImageTools>[1]) {
  let handler: ToolHandler | undefined;
  let config: ToolConfig | undefined;
  const fakeServer = {
    registerTool: (name: string, candidateConfig: ToolConfig, candidate: ToolHandler) => {
      if (name === toolName) {
        handler = candidate;
        config = candidateConfig;
      }
    },
  } as unknown as McpServer;
  registerProfileImageTools(fakeServer, ctx);
  if (!handler || !config) throw new Error(`${toolName} was not registered`);
  return { handler, schema: config.inputSchema };
}

function makeContext(fileGet = vi.fn()) {
  const baseServiceParams = {
    authenticated: true,
    provider: 'mcp',
    tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
    user: { user_id: 'user-1', role: 'member' },
  };
  return {
    ctx: {
      app: {
        get: (key: string) => (key === 'profileImageManager' ? managerMocks : undefined),
        service: (name: string) => {
          if (name === 'file') return { get: fileGet };
          throw new Error(`Unexpected service: ${name}`);
        },
      },
      db: {},
      userId: 'user-1',
      authenticatedUser: baseServiceParams.user,
      baseServiceParams,
    } as unknown as Parameters<typeof registerProfileImageTools>[1],
    baseServiceParams,
    fileGet,
  };
}

const created = { image_id: 'image-1', subject_type: 'teammate', is_primary: true };

describe('profile-image MCP write tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerMocks.upload.mockResolvedValue(created);
  });

  it('uploads decoded base64 bytes as the authenticated MCP caller', async () => {
    const { ctx } = makeContext();
    const { handler } = capture('agor_profile_images_upload', ctx);
    const pixels = Buffer.from('fake-png-bytes');

    const result = await handler({
      subjectType: 'teammate',
      subjectId: 'branch-1',
      imageBase64: `data:image/png;base64,${pixels.toString('base64')}`,
      altText: 'Portrait',
    });

    const [caller, input] = managerMocks.upload.mock.calls[0];
    expect(caller).toMatchObject({ tenantId: 'tenant-a', userId: 'user-1' });
    expect(input).toMatchObject({
      subjectType: 'teammate',
      subjectId: 'branch-1',
      altText: 'Portrait',
    });
    expect(Buffer.compare(input.data, pixels)).toBe(0);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ image_id: 'image-1' });
  });

  it('reads a branch-relative image through the file service with caller params', async () => {
    const pixels = Buffer.from('branch-image');
    const { ctx, baseServiceParams, fileGet } = makeContext(
      vi.fn(async () => ({
        encoding: 'base64',
        size: pixels.byteLength,
        content: pixels.toString('base64'),
      }))
    );
    const { handler } = capture('agor_profile_images_upload', ctx);

    await handler({
      subjectType: 'board',
      subjectId: 'board-1',
      branchId: 'abc12345',
      path: 'assets/cover.webp',
    });

    expect(fileGet).toHaveBeenCalledWith('assets/cover.webp', {
      ...baseServiceParams,
      query: { branch_id: 'resolved-abc12345' },
      // A 25 MB image arrives base64-encoded in a JSON frame; the default
      // 8 MiB executor response limit would reject anything over ~6 MB.
      [FILE_READ_MIN_RESPONSE_BYTES]: expect.any(Number),
    });
    const readParams = fileGet.mock.calls[0][1];
    expect(readParams[FILE_READ_MIN_RESPONSE_BYTES]).toBeGreaterThan(
      Math.ceil((25 * 1024 * 1024) / 3) * 4
    );
    const [, input] = managerMocks.upload.mock.calls[0];
    expect(input.originalName).toBe('cover.webp');
    expect(Buffer.compare(input.data, pixels)).toBe(0);
  });

  it('refuses a text file path without uploading', async () => {
    const { ctx } = makeContext(
      vi.fn(async () => ({ encoding: 'utf-8', size: 4, content: 'text' }))
    );
    const { handler } = capture('agor_profile_images_upload', ctx);

    await expect(
      handler({ subjectType: 'board', subjectId: 'board-1', branchId: 'b', path: 'notes.md' })
    ).rejects.toThrow('JPEG, PNG, or WebP');
    expect(managerMocks.upload).not.toHaveBeenCalled();
  });

  it('rejects malformed base64 without uploading', async () => {
    const { ctx } = makeContext();
    const { handler } = capture('agor_profile_images_upload', ctx);

    await expect(
      handler({ subjectType: 'board', subjectId: 'board-1', imageBase64: 'not base64!' })
    ).rejects.toThrow('base64-encoded');
    expect(managerMocks.upload).not.toHaveBeenCalled();
  });

  it('requires exactly one image source', () => {
    const { ctx } = makeContext();
    const { schema } = capture('agor_profile_images_upload', ctx);
    const subject = { subjectType: 'board', subjectId: 'board-1' };

    expect(schema.safeParse(subject).success).toBe(false);
    expect(
      schema.safeParse({ ...subject, imageBase64: 'aGk=', branchId: 'b', path: 'x.png' }).success
    ).toBe(false);
    expect(schema.safeParse({ ...subject, path: 'x.png' }).success).toBe(false);
    expect(schema.safeParse({ ...subject, imageBase64: 'aGk=' }).success).toBe(true);
    expect(schema.safeParse({ ...subject, branchId: 'b', path: 'x.png' }).success).toBe(true);
  });

  it('maps update arguments onto the gallery patch', async () => {
    managerMocks.update.mockResolvedValue({ image_id: 'image-1', is_primary: true });
    const { ctx } = makeContext();
    const { handler } = capture('agor_profile_images_update', ctx);

    await handler({ imageId: 'image-1', isPrimary: true, position: 2, altText: null });

    expect(managerMocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a' }),
      'image-1',
      { is_primary: true, position: 2, alt_text: '' }
    );
  });

  it('passes a theme on upload and maps update themes, clearing on null', async () => {
    managerMocks.update.mockResolvedValue({ image_id: 'image-1' });
    const { ctx } = makeContext();
    await capture('agor_profile_images_upload', ctx).handler({
      subjectType: 'teammate',
      subjectId: 'branch-1',
      imageBase64: Buffer.from('x').toString('base64'),
      theme: 'Winter',
    });
    expect(managerMocks.upload.mock.calls[0][1]).toMatchObject({ theme: 'Winter' });

    const update = capture('agor_profile_images_update', ctx);
    await update.handler({ imageId: 'image-1', theme: 'Summer' });
    expect(managerMocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a' }),
      'image-1',
      { theme: 'Summer' }
    );
    await update.handler({ imageId: 'image-1', theme: null });
    expect(managerMocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a' }),
      'image-1',
      { theme: '' }
    );
    expect(update.schema.safeParse({ imageId: 'image-1', theme: 'x'.repeat(41) }).success).toBe(
      false
    );
  });

  it('sets the active theme through the shared manager', async () => {
    managerMocks.setActiveTheme.mockResolvedValue({ active_theme: 'Winter' });
    const { ctx } = makeContext();
    const { handler, schema } = capture('agor_profile_images_set_active_theme', ctx);

    const result = await handler({ teammateId: 'branch-1', theme: 'Winter' });
    expect(managerMocks.setActiveTheme).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', userId: 'user-1' }),
      'branch-1',
      'Winter'
    );
    expect(JSON.parse(result.content[0].text)).toEqual({ active_theme: 'Winter' });

    await handler({ teammateId: 'branch-1', theme: null });
    expect(managerMocks.setActiveTheme).toHaveBeenLastCalledWith(
      expect.anything(),
      'branch-1',
      null
    );
    // The theme is required: omitting it must be explicit (null) rather than a silent no-op.
    expect(schema.safeParse({ teammateId: 'branch-1' }).success).toBe(false);
  });

  it('deletes through the shared manager', async () => {
    const { ctx } = makeContext();
    const { handler } = capture('agor_profile_images_delete', ctx);

    const result = await handler({ imageId: 'image-1' });

    expect(managerMocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', userId: 'user-1' }),
      'image-1'
    );
    expect(JSON.parse(result.content[0].text)).toEqual({ deleted: true, image_id: 'image-1' });
  });
});
