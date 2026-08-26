import type {
  BranchID,
  ProfileImage,
  ProfileImageID,
  ProfileImageSubjectType,
  ProfileImageVariant,
  TenantID,
  UserID,
} from '@agor/core/types';
import { and, asc, eq } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, runDatabaseTransaction, select, update } from '../database-wrapper';
import { type ProfileImageRow, profileImages } from '../schema';
import { RepositoryError } from './base';

export interface ProfileImageSubject {
  type: ProfileImageSubjectType;
  id: UserID | BranchID;
}

export interface ProcessedProfileImageInput {
  tenantId: TenantID;
  subject: ProfileImageSubject;
  createdBy: UserID;
  originalName: string;
  altText?: string;
  small: { data: Buffer; contentType: string; width: number; height: number };
  large: { data: Buffer; contentType: string; width: number; height: number };
}

function subjectPredicate(subject: ProfileImageSubject) {
  return subject.type === 'user'
    ? eq(profileImages.user_id, subject.id)
    : eq(profileImages.branch_id, subject.id);
}

function rowSubject(row: ProfileImageRow): ProfileImageSubject {
  if (row.user_id && !row.branch_id) return { type: 'user', id: row.user_id as UserID };
  if (row.branch_id && !row.user_id) {
    return { type: 'teammate', id: row.branch_id as BranchID };
  }
  throw new RepositoryError('Profile image has invalid subject ownership');
}

function logical(row: ProfileImageRow): ProfileImage {
  const subject = rowSubject(row);
  return {
    image_id: row.image_id as ProfileImageID,
    subject_type: subject.type,
    subject_id: subject.id,
    created_by: row.created_by as UserID,
    original_name: row.original_name,
    alt_text: row.alt_text ?? undefined,
    position: row.position,
    is_primary: row.is_primary,
    small_width: row.small_width,
    small_height: row.small_height,
    large_width: row.large_width,
    large_height: row.large_height,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/** Tenant-scoped persistence for processed profile-image galleries. */
export class ProfileImageRepository {
  constructor(private readonly db: Database) {}

  async listForSubject(_tenantId: TenantID, subject: ProfileImageSubject): Promise<ProfileImage[]> {
    const rows = await select(this.db)
      .from(profileImages)
      .where(subjectPredicate(subject))
      .orderBy(asc(profileImages.position), asc(profileImages.created_at))
      .all();
    return rows.map((row: ProfileImageRow) => logical(row));
  }

  async findById(_tenantId: TenantID, imageId: ProfileImageID): Promise<ProfileImage | null> {
    const row = await select(this.db)
      .from(profileImages)
      .where(eq(profileImages.image_id, imageId))
      .one();
    return row ? logical(row) : null;
  }

  async create(input: ProcessedProfileImageInput): Promise<ProfileImage> {
    const imageId = generateId() as ProfileImageID;
    const now = new Date();
    await runDatabaseTransaction(this.db, async (tx) => {
      const existing = await select(tx)
        .from(profileImages)
        .where(subjectPredicate(input.subject))
        .orderBy(asc(profileImages.position), asc(profileImages.created_at))
        .all();
      const isPrimary = existing.length === 0 || !existing.some((row) => row.is_primary);
      const position = existing.reduce((max, row) => Math.max(max, row.position), -1) + 1;
      await insert(tx, profileImages)
        .values({
          image_id: imageId,
          ...(input.subject.type === 'user'
            ? { user_id: input.subject.id, branch_id: null }
            : { user_id: null, branch_id: input.subject.id }),
          created_by: input.createdBy,
          original_name: input.originalName,
          alt_text: input.altText ?? null,
          position,
          is_primary: isPrimary,
          small_data: input.small.data,
          small_content_type: input.small.contentType,
          small_width: input.small.width,
          small_height: input.small.height,
          large_data: input.large.data,
          large_content_type: input.large.contentType,
          large_width: input.large.width,
          large_height: input.large.height,
          created_at: now,
          updated_at: now,
        })
        .run();
    });
    const created = await this.findById(input.tenantId, imageId);
    if (!created) throw new RepositoryError('Failed to create profile image');
    return created;
  }

  async patch(
    tenantId: TenantID,
    imageId: ProfileImageID,
    patch: { altText?: string | null; position?: number; isPrimary?: boolean }
  ): Promise<ProfileImage | null> {
    const existing = await this.findById(tenantId, imageId);
    if (!existing) return null;
    const subject: ProfileImageSubject = {
      type: existing.subject_type,
      id: existing.subject_id,
    };
    await runDatabaseTransaction(this.db, async (tx) => {
      if (patch.isPrimary === true) {
        await update(tx, profileImages)
          .set({ is_primary: false, updated_at: new Date() })
          .where(subjectPredicate(subject))
          .run();
      }
      await update(tx, profileImages)
        .set({
          ...(patch.altText !== undefined ? { alt_text: patch.altText } : {}),
          ...(patch.position !== undefined ? { position: patch.position } : {}),
          ...(patch.isPrimary !== undefined ? { is_primary: patch.isPrimary } : {}),
          updated_at: new Date(),
        })
        .where(and(eq(profileImages.image_id, imageId), subjectPredicate(subject)))
        .run();
    });
    return this.findById(tenantId, imageId);
  }

  async remove(
    tenantId: TenantID,
    imageId: ProfileImageID
  ): Promise<{ removed: ProfileImage; replacementPrimary: ProfileImage | null } | null> {
    const existing = await this.findById(tenantId, imageId);
    if (!existing) return null;
    const subject: ProfileImageSubject = {
      type: existing.subject_type,
      id: existing.subject_id,
    };
    let replacementPrimary: ProfileImage | null = null;
    await runDatabaseTransaction(this.db, async (tx) => {
      await deleteFrom(tx, profileImages).where(eq(profileImages.image_id, imageId)).run();
      if (!existing.is_primary) return;
      const replacement = await select(tx)
        .from(profileImages)
        .where(subjectPredicate(subject))
        .orderBy(asc(profileImages.position), asc(profileImages.created_at))
        .one();
      if (!replacement) return;
      await update(tx, profileImages)
        .set({ is_primary: true, updated_at: new Date() })
        .where(eq(profileImages.image_id, replacement.image_id))
        .run();
      replacementPrimary = logical({ ...replacement, is_primary: true, updated_at: new Date() });
    });
    return { removed: existing, replacementPrimary };
  }

  async readVariant(
    _tenantId: TenantID,
    imageId: ProfileImageID,
    variant: ProfileImageVariant
  ): Promise<{ image: ProfileImage; data: Buffer; contentType: string } | null> {
    const row = await select(this.db)
      .from(profileImages)
      .where(eq(profileImages.image_id, imageId))
      .one();
    if (!row) return null;
    return {
      image: logical(row),
      data: Buffer.from(variant === 'small' ? row.small_data : row.large_data),
      contentType: variant === 'small' ? row.small_content_type : row.large_content_type,
    };
  }
}
