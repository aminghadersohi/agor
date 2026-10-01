import type {
  BoardID,
  BranchID,
  ProfileImage,
  ProfileImageID,
  ProfileImageSubjectType,
  ProfileImageVariant,
  TenantID,
  UserID,
} from '@agor/core/types';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import { normalizeProfileImageTheme } from '../../types/profile-image';
import type { Database } from '../client';
import { deleteFrom, insert, runDatabaseTransaction, select, update } from '../database-wrapper';
import { type ProfileImageRow, profileImages } from '../schema';
import { RepositoryError } from './base';

export interface ProfileImageSubject {
  type: ProfileImageSubjectType;
  id: UserID | BranchID | BoardID;
}

export interface ProcessedProfileImageInput {
  tenantId: TenantID;
  subject: ProfileImageSubject;
  createdBy: UserID;
  originalName: string;
  altText?: string;
  theme?: string;
  small: { data: Buffer; contentType: string; width: number; height: number };
  large: { data: Buffer; contentType: string; width: number; height: number };
}

function subjectPredicate(subject: ProfileImageSubject) {
  if (subject.type === 'user') return eq(profileImages.user_id, subject.id);
  if (subject.type === 'teammate') return eq(profileImages.branch_id, subject.id);
  return eq(profileImages.board_id, subject.id);
}

function rowSubject(row: ProfileImageRow): ProfileImageSubject {
  if (row.user_id && !row.branch_id && !row.board_id) {
    return { type: 'user', id: row.user_id as UserID };
  }
  if (row.branch_id && !row.user_id && !row.board_id) {
    return { type: 'teammate', id: row.branch_id as BranchID };
  }
  if (row.board_id && !row.user_id && !row.branch_id) {
    return { type: 'board', id: row.board_id as BoardID };
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
    theme: normalizeProfileImageTheme(row.theme),
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
      const isPrimary =
        existing.length === 0 || !existing.some((row: ProfileImageRow) => row.is_primary);
      const position =
        existing.reduce((max: number, row: ProfileImageRow) => Math.max(max, row.position), -1) + 1;
      await insert(tx, profileImages)
        .values({
          image_id: imageId,
          ...(input.subject.type === 'user'
            ? { user_id: input.subject.id, branch_id: null, board_id: null }
            : input.subject.type === 'teammate'
              ? { user_id: null, branch_id: input.subject.id, board_id: null }
              : { user_id: null, branch_id: null, board_id: input.subject.id }),
          created_by: input.createdBy,
          original_name: input.originalName,
          alt_text: input.altText ?? null,
          theme: normalizeProfileImageTheme(input.theme) ?? null,
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
    patch: {
      altText?: string | null;
      theme?: string | null;
      position?: number;
      isPrimary?: boolean;
    }
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
          ...(patch.theme !== undefined
            ? { theme: normalizeProfileImageTheme(patch.theme) ?? null }
            : {}),
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

  /**
   * Rewrite gallery order. `orderedIds` lead (unknown or repeated ids are
   * ignored); every image it omits keeps its relative order after them, so a
   * partial list can never drop or duplicate a position.
   */
  async reorder(
    tenantId: TenantID,
    subject: ProfileImageSubject,
    orderedIds: ProfileImageID[]
  ): Promise<ProfileImage[]> {
    await runDatabaseTransaction(this.db, async (tx) => {
      const existing = await select(tx)
        .from(profileImages)
        .where(subjectPredicate(subject))
        .orderBy(asc(profileImages.position), asc(profileImages.created_at))
        .all();
      const known = new Set(existing.map((row: ProfileImageRow) => row.image_id));
      const leading = [...new Set(orderedIds)].filter((id) => known.has(id));
      const leadingSet = new Set<string>(leading);
      const next = [
        ...leading,
        ...existing
          .map((row: ProfileImageRow) => row.image_id)
          .filter((id: string) => !leadingSet.has(id)),
      ];
      const now = new Date();
      for (const [position, imageId] of next.entries()) {
        const current = existing.find((row: ProfileImageRow) => row.image_id === imageId);
        if (current?.position === position) continue;
        await update(tx, profileImages)
          .set({ position, updated_at: now })
          .where(and(eq(profileImages.image_id, imageId), subjectPredicate(subject)))
          .run();
      }
    });
    return this.listForSubject(tenantId, subject);
  }

  /** Set (or with null clear) the theme of several images of one subject at once. */
  async setThemes(
    tenantId: TenantID,
    subject: ProfileImageSubject,
    imageIds: ProfileImageID[],
    theme: string | null
  ): Promise<ProfileImage[]> {
    if (imageIds.length > 0) {
      await update(this.db, profileImages)
        .set({ theme: normalizeProfileImageTheme(theme) ?? null, updated_at: new Date() })
        .where(and(inArray(profileImages.image_id, imageIds), subjectPredicate(subject)))
        .run();
    }
    return this.listForSubject(tenantId, subject);
  }

  /**
   * Delete several images of one subject. When the primary is among them the
   * first survivor in gallery order takes over, as in {@link remove}.
   */
  async removeMany(
    tenantId: TenantID,
    subject: ProfileImageSubject,
    imageIds: ProfileImageID[]
  ): Promise<{ removed: ProfileImage[]; replacementPrimary: ProfileImage | null }> {
    const before = await this.listForSubject(tenantId, subject);
    const doomed = new Set<string>(imageIds);
    const removed = before.filter((image) => doomed.has(image.image_id));
    if (removed.length === 0) return { removed, replacementPrimary: null };
    const removedPrimary = removed.some((image) => image.is_primary);
    const survivor = before.find((image) => !doomed.has(image.image_id)) ?? null;
    await runDatabaseTransaction(this.db, async (tx) => {
      await deleteFrom(tx, profileImages)
        .where(
          and(
            inArray(
              profileImages.image_id,
              removed.map((image) => image.image_id)
            ),
            subjectPredicate(subject)
          )
        )
        .run();
      if (removedPrimary && survivor) {
        await update(tx, profileImages)
          .set({ is_primary: true, updated_at: new Date() })
          .where(eq(profileImages.image_id, survivor.image_id))
          .run();
      }
    });
    return {
      removed,
      replacementPrimary: removedPrimary && survivor ? { ...survivor, is_primary: true } : null,
    };
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
