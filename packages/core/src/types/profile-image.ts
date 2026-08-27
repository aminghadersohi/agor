import type { BranchID, UserID, UUID } from './id';

/** Durable identifier for one processed profile-gallery image. */
export type ProfileImageID = UUID;

export type ProfileImageSubjectType = 'user' | 'teammate';
export type ProfileImageVariant = 'small' | 'large';
export type ProfileIdentityModelProvider = 'meshy';
export type ProfileIdentityModelStatus =
  | 'submitting'
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'canceled';

/** Public, secret-free state for a generated 3D identity model. */
export interface ProfileIdentityModel {
  provider: ProfileIdentityModelProvider;
  status: ProfileIdentityModelStatus;
  progress: number;
  model_available: boolean;
  error_message?: string;
  created_at: string;
  updated_at: string;
}

/** Public metadata for a tenant-owned profile image. Pixel bytes are served separately. */
export interface ProfileImage {
  image_id: ProfileImageID;
  subject_type: ProfileImageSubjectType;
  subject_id: UserID | BranchID;
  created_by: UserID;
  original_name: string;
  alt_text?: string;
  position: number;
  is_primary: boolean;
  small_width: number;
  small_height: number;
  large_width: number;
  large_height: number;
  identity_model?: ProfileIdentityModel;
  created_at: string;
  updated_at: string;
}

export interface ProfileImageListResult {
  images: ProfileImage[];
  max_images: number;
}

export interface ProfileImagePatch {
  alt_text?: string;
  is_primary?: boolean;
  position?: number;
}
