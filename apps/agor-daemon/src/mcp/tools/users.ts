import { DEFAULT_STATIC_TENANT_ID } from '@agor/core/config';
import { ProfileImageRepository } from '@agor/core/db';
import { BadRequest, NotFound } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  BoardID,
  Branch,
  BranchID,
  FileDetail,
  ProfileImage,
  ProfileImageID,
  ProfileImagePatch,
  ProfileImageSubjectType,
  TenantID,
  UserID,
} from '@agor/core/types';
import { isTeammate, ROLES, type User } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  getProfileImageManager,
  profileImageCallerFromParams,
} from '../../utils/profile-image-management.js';
import {
  PROFILE_IMAGE_MAX_BYTES,
  PROFILE_IMAGE_MAX_GALLERY_ITEMS,
  PROFILE_IMAGE_MAX_MB,
} from '../../utils/profile-image-processing.js';
import { resolveBranchId } from '../resolve-ids.js';
import { mcpOptionalId, mcpOptionalString, mcpRequiredId, mcpRequiredString } from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope } from '../tenant-scope.js';

const USER_LIST_FIELDS = [
  'user_id',
  'email',
  'name',
  'emoji',
  'role',
  'unix_username',
  'created_at',
  'updated_at',
] as const;

const USER_QUERY_LIMIT_MAX = 100;
const USER_FIELD_FILTER_SCAN_LIMIT = 10000;

type UserListField = (typeof USER_LIST_FIELDS)[number];
type UserListRow = Pick<User, UserListField>;
type UserFindField = 'email' | 'name' | 'unix_username';

function compactUser(user: User, fields?: UserListField[]): Partial<UserListRow> {
  const selectedFields = fields && fields.length > 0 ? fields : USER_LIST_FIELDS;
  return Object.fromEntries(
    selectedFields.map((field) => [field, user[field]])
  ) as Partial<UserListRow>;
}

function compactUsersResult(
  result: { total: number; limit: number; skip: number; data: User[] },
  fields?: UserListField[]
) {
  return {
    ...result,
    data: result.data.map((user) => compactUser(user, fields)),
  };
}

function includesCaseInsensitive(value: string | undefined, term: string): boolean {
  return value?.toLowerCase().includes(term.toLowerCase()) ?? false;
}

export function registerUserTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_users_list
  server.registerTool(
    'agor_users_list',
    {
      description:
        'List users in the system with pagination and optional case-insensitive search across name, email, and execution home key. Returns compact rows by default; pass lean:false for detailed user payloads.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        limit: z
          .number({ error: 'limit must be a positive integer when provided.' })
          .int('limit must be an integer.')
          .positive('limit must be greater than 0.')
          .max(USER_QUERY_LIMIT_MAX, `limit must be less than or equal to ${USER_QUERY_LIMIT_MAX}.`)
          .optional()
          .describe('Maximum number of results (default: 50)'),
        skip: z
          .number({ error: 'skip must be a non-negative integer when provided.' })
          .int('skip must be an integer.')
          .nonnegative('skip must be greater than or equal to 0.')
          .max(USER_QUERY_LIMIT_MAX, `skip must be less than or equal to ${USER_QUERY_LIMIT_MAX}.`)
          .optional()
          .describe('Number of results to skip'),
        search: mcpOptionalString(
          'search',
          'Case-insensitive search across name, email, and execution home key'
        ),
        lean: z
          .boolean()
          .optional()
          .describe('Return compact rows only (default: true). Set false for detailed users.'),
        fields: z
          .array(z.enum(USER_LIST_FIELDS))
          .optional()
          .describe('Optional compact fields to return when lean is true'),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {
        $limit: args.limit ?? 50,
        $skip: args.skip ?? 0,
      };
      if (args.search) query.search = args.search;

      const users = (await ctx.app.service('users').find({
        query,
        ...ctx.baseServiceParams,
      })) as { total: number; limit: number; skip: number; data: User[] };

      return textResult(args.lean === false ? users : compactUsersResult(users, args.fields));
    }
  );

  // Tool 2: agor_users_find
  server.registerTool(
    'agor_users_find',
    {
      description:
        'Find users by name, email, or unix_username. Useful before admin updates: returns compact matching rows with user_id. Pass email when available; matching is case-insensitive substring.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        search: mcpOptionalString(
          'search',
          'Case-insensitive search across name, email, and execution home key'
        ),
        email: mcpOptionalString('email', 'Email to search for (case-insensitive substring)'),
        name: mcpOptionalString('name', 'Name to search for (case-insensitive substring)'),
        unix_username: mcpOptionalString(
          'unix_username',
          'Execution home key to search for (case-insensitive substring)'
        ),
        limit: z
          .number({ error: 'limit must be a positive integer when provided.' })
          .int('limit must be an integer.')
          .positive('limit must be greater than 0.')
          .max(USER_QUERY_LIMIT_MAX, `limit must be less than or equal to ${USER_QUERY_LIMIT_MAX}.`)
          .optional()
          .describe('Maximum number of matches (default: 10)'),
      }),
    },
    async (args) => {
      const genericTerms = [args.search].filter(
        (term): term is string => typeof term === 'string' && term.trim().length > 0
      );
      const fieldFilters = (
        [
          ['email', args.email],
          ['name', args.name],
          ['unix_username', args.unix_username],
        ] satisfies Array<[UserFindField, string | undefined]>
      ).filter((filter): filter is [UserFindField, string] => {
        const [, term] = filter;
        return typeof term === 'string' && term.trim().length > 0;
      });
      const firstFieldTerm = fieldFilters[0]?.[1];
      const searchTerm = genericTerms[0] ?? firstFieldTerm;

      if (!searchTerm) {
        throw new Error('Provide one of: search, email, name, or unix_username');
      }

      const requestedLimit = args.limit ?? 10;
      const users = (await ctx.app.service('users').find({
        query: {
          search: searchTerm,
          $limit: fieldFilters.length > 0 ? USER_FIELD_FILTER_SCAN_LIMIT : requestedLimit,
          $skip: 0,
        },
        ...ctx.baseServiceParams,
      })) as { total: number; limit: number; skip: number; data: User[] };

      if (fieldFilters.length === 0) {
        return textResult(compactUsersResult(users));
      }

      const filteredData = users.data.filter((user) =>
        fieldFilters.every(([field, term]) => includesCaseInsensitive(user[field], term))
      );

      return textResult(
        compactUsersResult({
          total: filteredData.length,
          limit: requestedLimit,
          skip: 0,
          data: filteredData.slice(0, requestedLimit),
        })
      );
    }
  );

  // Tool 3: agor_users_get
  server.registerTool(
    'agor_users_get',
    {
      description: 'Get detailed information about a specific user',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        userId: mcpRequiredId('userId', 'User', 'User ID (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const user = await ctx.app.service('users').get(args.userId, ctx.baseServiceParams);
      return textResult(user);
    }
  );

  // Tool 4: agor_users_get_current
  server.registerTool(
    'agor_users_get_current',
    {
      description:
        'Get information about the current authenticated user (the user associated with this MCP session)',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({}),
    },
    async () => {
      const user = await ctx.app.service('users').get(ctx.userId, ctx.baseServiceParams);
      return textResult(user);
    }
  );

  // Tool 5: agor_users_update_current
  server.registerTool(
    'agor_users_update_current',
    {
      description:
        'Update the current user profile (name, emoji, avatar, preferences). Can only update own profile.',
      annotations: { idempotentHint: true },
      inputSchema: z.strictObject({
        name: mcpOptionalString('name', 'Display name'),
        emoji: mcpOptionalString('emoji', 'User emoji (single emoji character)'),
        avatar_url: mcpOptionalString('avatar_url', 'Avatar URL'),
        avatar: mcpOptionalString('avatar', 'Legacy avatar URL alias'),
        preferences: z
          .object({})
          .passthrough()
          .optional()
          .describe('User preferences (JSON object)'),
      }),
    },
    async (args) => {
      const updateData: Record<string, unknown> = {};
      if (args.name !== undefined) updateData.name = args.name;
      if (args.emoji !== undefined) updateData.emoji = args.emoji;
      if (args.avatar_url !== undefined) updateData.avatar_url = args.avatar_url;
      if (args.avatar !== undefined) updateData.avatar = args.avatar;
      if (args.preferences !== undefined) updateData.preferences = args.preferences;
      const updatedUser = await ctx.app
        .service('users')
        .patch(ctx.userId, updateData, ctx.baseServiceParams);
      return textResult(updatedUser);
    }
  );

  // Tool 6: agor_users_update
  server.registerTool(
    'agor_users_update',
    {
      description:
        'Update any user account (admin operation). Only updates fields that are provided. Can update email, name, role, password, unix_username, must_change_password, emoji, avatar, and preferences.',
      annotations: { idempotentHint: true },
      inputSchema: z.strictObject({
        userId: mcpRequiredId('userId', 'User', 'User ID to update (UUIDv7 or short ID)'),
        email: mcpOptionalString('email', 'New email address (optional)'),
        name: mcpOptionalString('name', 'New display name (optional)'),
        password: mcpOptionalString(
          'password',
          'New password (optional; secure daemon policy is enforced before hashing)'
        ),
        role: z
          .enum([ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MEMBER, ROLES.VIEWER])
          .optional()
          .describe(
            'New user role (optional). superadmin=full system access + branch RBAC bypass, admin=manage resources, member=standard user, viewer=read-only'
          ),
        unix_username: mcpOptionalString(
          'unix_username',
          'New opaque execution home key (optional)'
        ),
        must_change_password: z
          .boolean()
          .optional()
          .describe('Force user to change password on next login (optional)'),
        emoji: mcpOptionalString('emoji', 'User emoji (optional, single emoji character)'),
        avatar_url: mcpOptionalString('avatar_url', 'Avatar URL (optional)'),
        avatar: mcpOptionalString('avatar', 'Legacy avatar URL alias (optional)'),
        preferences: z
          .object({})
          .passthrough()
          .optional()
          .describe('User preferences (optional, JSON object)'),
      }),
    },
    async (args) => {
      const updateData: Record<string, unknown> = {};
      if (args.email !== undefined) updateData.email = args.email;
      if (args.name !== undefined) updateData.name = args.name;
      if (args.password !== undefined) updateData.password = args.password;
      if (args.role !== undefined) updateData.role = args.role;
      if (args.unix_username !== undefined) updateData.unix_username = args.unix_username;
      if (args.must_change_password !== undefined)
        updateData.must_change_password = args.must_change_password;
      if (args.emoji !== undefined) updateData.emoji = args.emoji;
      if (args.avatar_url !== undefined) updateData.avatar_url = args.avatar_url;
      if (args.avatar !== undefined) updateData.avatar = args.avatar;
      if (args.preferences !== undefined) updateData.preferences = args.preferences;

      if (Object.keys(updateData).length === 0) {
        throw new Error('Provide at least one update field.');
      }

      const updatedUser = await ctx.app
        .service('users')
        .patch(args.userId, updateData, ctx.baseServiceParams);
      return textResult(updatedUser);
    }
  );

  // Tool 7: agor_user_create
  server.registerTool(
    'agor_user_create',
    {
      description:
        'Create a new user account. Requires email and password. Optionally set name, emoji, avatar, unix_username, must_change_password, and role.',
      inputSchema: z.strictObject({
        email: mcpRequiredString('email', 'User email address (must be unique)'),
        password: mcpRequiredString(
          'password',
          'User password (secure daemon policy is enforced before hashing)'
        ),
        name: mcpOptionalString('name', 'Display name (optional)'),
        emoji: mcpOptionalString(
          'emoji',
          'User emoji for visual identity (optional, single emoji character)'
        ),
        avatar_url: mcpOptionalString('avatar_url', 'Avatar URL (optional)'),
        avatar: mcpOptionalString('avatar', 'Legacy avatar URL alias (optional)'),
        unix_username: mcpOptionalString(
          'unix_username',
          'Opaque execution home key (optional, defaults to email prefix)'
        ),
        must_change_password: z
          .boolean()
          .optional()
          .describe('Force user to change password on first login (optional, defaults to false)'),
        role: z
          .enum([ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MEMBER, ROLES.VIEWER])
          .optional()
          .describe(
            'User role (optional, defaults to "member"). Roles: superadmin=full system access + branch RBAC bypass, admin=manage resources, member=standard user, viewer=read-only'
          ),
      }),
    },
    async (args) => {
      const createData: Record<string, unknown> = {
        email: args.email,
        password: args.password,
      };
      if (args.name !== undefined) createData.name = args.name;
      if (args.emoji !== undefined) createData.emoji = args.emoji;
      if (args.avatar_url !== undefined) createData.avatar_url = args.avatar_url;
      if (args.avatar !== undefined) createData.avatar = args.avatar;
      if (args.unix_username !== undefined) createData.unix_username = args.unix_username;
      if (args.must_change_password !== undefined)
        createData.must_change_password = args.must_change_password;
      if (args.role !== undefined) createData.role = args.role;

      const newUser = await ctx.app.service('users').create(createData, ctx.baseServiceParams);
      return textResult(newUser);
    }
  );
}

// Profile-image tools register as their own `profile-images` domain but live
// in this entry: every src file is a separate non-split tsup entry, so a
// standalone registrar would ship another private copy of zod and the MCP
// server in agor-live.

function tenantIdFor(ctx: McpContext): TenantID {
  return ctx.baseServiceParams.tenant?.tenant_id ?? DEFAULT_STATIC_TENANT_ID;
}

async function authorizeSubject(
  ctx: McpContext,
  subjectType: ProfileImageSubjectType,
  subjectId: UserID | BranchID | BoardID
): Promise<void> {
  try {
    if (subjectType === 'user') {
      await ctx.app.service('users').get(subjectId as UserID, ctx.baseServiceParams);
      return;
    }

    if (subjectType === 'board') {
      await ctx.app.service('boards').get(subjectId as BoardID, ctx.baseServiceParams);
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

/**
 * Inline base64 travels inside the daemon's 10 MB JSON body limit, which stays
 * tight on purpose, so inline images cap at 7 MB (≈9.4 MB encoded). Larger
 * images up to PROFILE_IMAGE_MAX_BYTES go through branchId + path instead.
 */
const PROFILE_IMAGE_MAX_INLINE_BYTES = 7 * 1024 * 1024;
/** Base64 of the largest inline upload, plus room for a `data:` URL prefix. */
const PROFILE_IMAGE_MAX_BASE64_LENGTH = Math.ceil(PROFILE_IMAGE_MAX_INLINE_BYTES / 3) * 4 + 64;
const BASE64_PAYLOAD = /^[A-Za-z0-9+/_-]*={0,2}$/;

function profileImageCaller(ctx: McpContext) {
  return profileImageCallerFromParams(
    ctx.baseServiceParams as AuthenticatedParams,
    tenantIdFor(ctx)
  );
}

function decodeProfileImageBase64(value: string): Buffer {
  const payload = value.replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
  if (!payload || !BASE64_PAYLOAD.test(payload)) {
    throw new BadRequest('imageBase64 must be base64-encoded image bytes');
  }
  const data = Buffer.from(payload, 'base64');
  if (data.byteLength > PROFILE_IMAGE_MAX_INLINE_BYTES) {
    throw new BadRequest(
      'Inline images must be 7 MB or smaller; use branchId + path for larger images'
    );
  }
  return data;
}

/**
 * Read a gallery upload out of a branch through the `file` service, so the
 * read carries the caller's branch file access and runs in the executor like
 * every other branch file read; the daemon never opens the path itself.
 */
async function readBranchImage(
  ctx: McpContext,
  branchIdInput: string,
  path: string
): Promise<{ data: Buffer; name: string }> {
  const branchId = await resolveBranchId(ctx, branchIdInput);
  const file = (await ctx.app
    .service('file')
    .get(path, { ...ctx.baseServiceParams, query: { branch_id: branchId } })) as FileDetail;
  if (file.encoding !== 'base64') {
    throw new BadRequest('path must point to a JPEG, PNG, or WebP image');
  }
  if (file.size > PROFILE_IMAGE_MAX_BYTES) {
    throw new BadRequest(`Images must be ${PROFILE_IMAGE_MAX_MB} MB or smaller`);
  }
  return { data: Buffer.from(file.content, 'base64'), name: path.split('/').pop() || path };
}

/**
 * Permission-aware access to processed user, teammate, and board galleries.
 * Writes share authorization, the gallery cap, image processing, and primary
 * projection with the browser upload routes.
 */
export function registerProfileImageTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'agor_profile_images_list',
    {
      description:
        'List processed image-gallery metadata for an accessible Agor user, teammate, or board. Returns image IDs, primary ordering, alt text, and small/large dimensions; use agor_profile_images_get to load pixels for artifact work.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        subjectType: z
          .enum(['user', 'teammate', 'board'])
          .describe('Image owner type: an Agor user, teammate branch, or board'),
        subjectId: mcpRequiredId(
          'subjectId',
          'Profile subject',
          'User, teammate branch, or board ID (UUIDv7 or short ID)'
        ),
      }),
    },
    async (args) => {
      const subject = {
        type: args.subjectType,
        id: args.subjectId as UserID | BranchID | BoardID,
      } as const;
      await authorizeSubject(ctx, subject.type, subject.id);
      const images = await runWithMcpTenantDatabaseScope(ctx, (db) =>
        new ProfileImageRepository(db).listForSubject(tenantIdFor(ctx), subject)
      );
      return textResult({ images, max_images: PROFILE_IMAGE_MAX_GALLERY_ITEMS });
    }
  );

  server.registerTool(
    'agor_profile_images_get',
    {
      description:
        'Load one processed image for an accessible Agor user, teammate, or board as MCP image content. Choose small for avatars and compact artifacts, or large for galleries and visual identity experiences. Original uploads and storage details are never exposed.',
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
      const image = await runWithMcpTenantDatabaseScope(ctx, (db) =>
        new ProfileImageRepository(db).findById(tenantIdFor(ctx), imageId)
      );
      if (!image) throw new NotFound('Profile image unavailable');
      await authorizeImage(ctx, image);

      const result = await runWithMcpTenantDatabaseScope(ctx, (db) =>
        new ProfileImageRepository(db).readVariant(tenantIdFor(ctx), imageId, variant)
      );
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

  server.registerTool(
    'agor_profile_images_upload',
    {
      description: `Add an image to the gallery of an Agor user, teammate, or board. The first image becomes the main (primary) image and is what avatars show. The daemon re-encodes the upload into small and large WebP variants and strips its metadata; JPEG, PNG, and WebP up to ${PROFILE_IMAGE_MAX_MB} MB are accepted via branchId + path (7 MB via imageBase64), ${PROFILE_IMAGE_MAX_GALLERY_ITEMS} images per gallery.

Provide exactly one source:
- branchId + path: a branch-relative image file, read with your branch file access (preferred for anything but tiny images).
- imageBase64: raw base64 or a data: URL.

Managing a user gallery requires being that user or an admin; a board gallery requires board edit access; a teammate gallery requires Manager access to the teammate branch.`,
      inputSchema: z
        .strictObject({
          subjectType: z
            .enum(['user', 'teammate', 'board'])
            .describe('Gallery owner type: an Agor user, teammate branch, or board'),
          subjectId: mcpRequiredId(
            'subjectId',
            'Profile subject',
            'User, teammate branch, or board ID (UUIDv7 or short ID)'
          ),
          branchId: mcpOptionalId(
            'branchId',
            'Branch',
            'Branch containing the image file (use with path)'
          ),
          path: mcpOptionalString('path', 'Branch-relative image file path (use with branchId)'),
          imageBase64: z
            .string()
            .max(
              PROFILE_IMAGE_MAX_BASE64_LENGTH,
              'imageBase64 exceeds the 7 MB inline limit; use branchId + path for larger images.'
            )
            .optional()
            .describe('Base64 image bytes or a data: URL (alternative to branchId + path)'),
          originalName: mcpOptionalString(
            'originalName',
            'File name recorded for the image (default: the path basename)'
          ),
          altText: mcpOptionalString('altText', 'Accessible description of the image'),
        })
        .refine((args) => Boolean(args.imageBase64) !== Boolean(args.branchId || args.path), {
          message: 'Provide either imageBase64 or branchId + path, not both.',
        })
        .refine((args) => Boolean(args.branchId) === Boolean(args.path), {
          message: 'branchId and path must be provided together.',
        }),
    },
    async (args) => {
      const source =
        args.branchId && args.path
          ? await readBranchImage(ctx, args.branchId, args.path)
          : { data: decodeProfileImageBase64(args.imageBase64 ?? ''), name: undefined };
      const created = await getProfileImageManager(ctx.app).upload(profileImageCaller(ctx), {
        subjectType: args.subjectType,
        subjectId: args.subjectId as UserID | BranchID | BoardID,
        data: source.data,
        originalName: args.originalName ?? source.name,
        altText: args.altText,
      });
      return textResult(created);
    }
  );

  server.registerTool(
    'agor_profile_images_update',
    {
      description:
        'Update one gallery image of an Agor user, teammate, or board: make it the main (primary) image, move it to another position, or change its alt text. Requires the same manage access as agor_profile_images_upload.',
      inputSchema: z.strictObject({
        imageId: mcpRequiredId('imageId', 'Profile image'),
        isPrimary: z
          .literal(true)
          .optional()
          .describe('Make this the main image (the previous main image is demoted)'),
        position: z
          .number({ error: 'position must be a non-negative integer when provided.' })
          .int('position must be an integer.')
          .min(0, 'position must be 0 or greater.')
          .optional()
          .describe('Gallery order position (0 = first)'),
        altText: z
          .string()
          .max(240, 'altText must be 240 characters or fewer.')
          .nullable()
          .optional()
          .describe('Accessible description; null or an empty string clears it'),
      }),
    },
    async (args) => {
      const patch: ProfileImagePatch = {
        ...(args.isPrimary ? { is_primary: true } : {}),
        ...(args.position !== undefined ? { position: args.position } : {}),
        ...(args.altText !== undefined ? { alt_text: args.altText ?? '' } : {}),
      };
      const updated = await getProfileImageManager(ctx.app).update(
        profileImageCaller(ctx),
        args.imageId as ProfileImageID,
        patch
      );
      return textResult(updated);
    }
  );

  server.registerTool(
    'agor_profile_images_delete',
    {
      description:
        'Delete one gallery image of an Agor user, teammate, or board. Deleting the main image promotes the next gallery image, or clears the main image when none remain. Requires the same manage access as agor_profile_images_upload.',
      annotations: { destructiveHint: true },
      inputSchema: z.strictObject({
        imageId: mcpRequiredId('imageId', 'Profile image'),
      }),
    },
    async (args) => {
      const imageId = args.imageId as ProfileImageID;
      await getProfileImageManager(ctx.app).remove(profileImageCaller(ctx), imageId);
      return textResult({ deleted: true, image_id: imageId });
    }
  );
}
