import { DEFAULT_STATIC_TENANT_ID } from '@agor/core/config';
import { ProfileImageRepository } from '@agor/core/db';
import { NotFound } from '@agor/core/feathers';
import type {
  Branch,
  BranchID,
  ProfileImage,
  ProfileImageID,
  ProfileImageSubjectType,
  TenantID,
  UserID,
} from '@agor/core/types';
import { isTeammate } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { PROFILE_IMAGE_MAX_GALLERY_ITEMS } from '../../utils/profile-image-processing.js';
import { mcpRequiredId } from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

function tenantIdFor(ctx: McpContext): TenantID {
  return ctx.baseServiceParams.tenant?.tenant_id ?? DEFAULT_STATIC_TENANT_ID;
}

async function authorizeSubject(
  ctx: McpContext,
  subjectType: ProfileImageSubjectType,
  subjectId: UserID | BranchID
): Promise<void> {
  try {
    if (subjectType === 'user') {
      await ctx.app.service('users').get(subjectId as UserID, ctx.baseServiceParams);
      return;
    }

    const branch = (await ctx.app
      .service('branches')
      .get(subjectId as BranchID, ctx.baseServiceParams)) as Branch;
    if (isTeammate(branch)) return;
  } catch {
    // Keep unauthorized and missing subjects indistinguishable.
  }
  throw new NotFound('Profile unavailable');
}

async function authorizeImage(ctx: McpContext, image: ProfileImage): Promise<void> {
  await authorizeSubject(ctx, image.subject_type, image.subject_id);
}

/** Read-only, permission-aware access to processed user and teammate profile galleries. */
export function registerProfileImageTools(server: McpServer, ctx: McpContext): void {
  const repository = new ProfileImageRepository(ctx.db);

  server.registerTool(
    'agor_profile_images_list',
    {
      description:
        'List processed profile-gallery image metadata for an accessible Agor user or teammate. Returns image IDs, primary ordering, alt text, and small/large dimensions; use agor_profile_images_get to load pixels for artifact work.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        subjectType: z
          .enum(['user', 'teammate'])
          .describe('Profile owner type: an Agor user or teammate branch'),
        subjectId: mcpRequiredId(
          'subjectId',
          'Profile subject',
          'User or teammate branch ID (UUIDv7 or short ID)'
        ),
      }),
    },
    async (args) => {
      const subject = {
        type: args.subjectType,
        id: args.subjectId as UserID | BranchID,
      } as const;
      await authorizeSubject(ctx, subject.type, subject.id);
      const images = await repository.listForSubject(tenantIdFor(ctx), subject);
      return textResult({ images, max_images: PROFILE_IMAGE_MAX_GALLERY_ITEMS });
    }
  );

  server.registerTool(
    'agor_profile_images_get',
    {
      description:
        'Load one processed profile image for an accessible Agor user or teammate as MCP image content. Choose small for avatars and compact artifacts, or large for galleries and visual/3D identity experiences. Original uploads and storage details are never exposed.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        imageId: mcpRequiredId('imageId', 'Profile image'),
        variant: z
          .enum(['small', 'large'])
          .optional()
          .describe('Processed image size to return (default: large)'),
      }),
    },
    async (args) => {
      const imageId = args.imageId as ProfileImageID;
      const variant = args.variant ?? 'large';
      const image = await repository.findById(tenantIdFor(ctx), imageId);
      if (!image) throw new NotFound('Profile image unavailable');
      await authorizeImage(ctx, image);

      const result = await repository.readVariant(tenantIdFor(ctx), imageId, variant);
      if (!result) throw new NotFound('Profile image unavailable');

      const width = variant === 'small' ? image.small_width : image.large_width;
      const height = variant === 'small' ? image.small_height : image.large_height;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                image_id: image.image_id,
                subject_type: image.subject_type,
                subject_id: image.subject_id,
                variant,
                width,
                height,
                alt_text: image.alt_text ?? null,
                is_primary: image.is_primary,
              },
              null,
              2
            ),
          },
          {
            type: 'image' as const,
            data: result.data.toString('base64'),
            mimeType: result.contentType,
          },
        ],
      };
    }
  );
}
