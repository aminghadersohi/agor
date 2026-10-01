import type { BoardID, BranchID, UserID, UUID } from './id';

/** Durable identifier for one processed profile-gallery image. */
export type ProfileImageID = UUID;

export type ProfileImageSubjectType = 'user' | 'teammate' | 'board';
export type ProfileImageVariant = 'small' | 'large';

/** Public metadata for a tenant-owned profile image. Pixel bytes are served separately. */
export interface ProfileImage {
  image_id: ProfileImageID;
  subject_type: ProfileImageSubjectType;
  subject_id: UserID | BranchID | BoardID;
  created_by: UserID;
  original_name: string;
  alt_text?: string;
  /** Free-text theme label (e.g. "Winter"); unlabeled images belong to no theme. */
  theme?: string;
  position: number;
  is_primary: boolean;
  small_width: number;
  small_height: number;
  large_width: number;
  large_height: number;
  created_at: string;
  updated_at: string;
}

export interface ProfileImageListResult {
  images: ProfileImage[];
  max_images: number;
}

export interface ProfileImagePatch {
  alt_text?: string;
  /** Theme label; null or an empty string clears it. */
  theme?: string | null;
  is_primary?: boolean;
  position?: number;
}

/** Longest stored theme label. */
export const PROFILE_IMAGE_THEME_MAX_LENGTH = 40;

/**
 * Canonical stored form of a theme label: control characters and runs of
 * whitespace collapse to single spaces, then it is trimmed and capped.
 * Anything that is not a non-empty string means "no theme".
 */
export function normalizeProfileImageTheme(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROFILE_IMAGE_THEME_MAX_LENGTH)
    .trim();
  return clean || undefined;
}

/** Case-insensitive identity of a theme, so "Winter" and "winter " are one theme. */
export function profileImageThemeKey(value: unknown): string | undefined {
  return normalizeProfileImageTheme(value)?.toLocaleLowerCase();
}

/** Distinct themes used in a gallery, in first-seen gallery order, keeping first spelling. */
export function listProfileImageThemes(images: readonly Pick<ProfileImage, 'theme'>[]): string[] {
  const seen = new Map<string, string>();
  for (const image of images) {
    const theme = normalizeProfileImageTheme(image.theme);
    const key = theme?.toLocaleLowerCase();
    if (theme && key && !seen.has(key)) seen.set(key, theme);
  }
  return [...seen.values()];
}

/**
 * The images a surface should show for a teammate's active theme. An unset
 * theme, or one no image carries (e.g. its last image was deleted or
 * relabeled), selects the whole gallery so a teammate is never left photo-less.
 */
export function selectProfileImagesForTheme<T extends Pick<ProfileImage, 'theme'>>(
  images: readonly T[],
  activeTheme?: string | null
): T[] {
  const key = profileImageThemeKey(activeTheme);
  if (!key) return images.slice();
  const themed = images.filter((image) => profileImageThemeKey(image.theme) === key);
  return themed.length > 0 ? themed : images.slice();
}
