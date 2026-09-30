import sharp from 'sharp';

/**
 * Largest accepted upload. Originals are never stored — every upload is
 * re-encoded to the two WebP variants below — so this bounds request size and
 * decode work, not storage. 25 MB admits full-resolution camera JPEGs.
 */
export const PROFILE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const PROFILE_IMAGE_MAX_MB = PROFILE_IMAGE_MAX_BYTES / (1024 * 1024);
/** Decoded-pixel ceiling: ~64 MP covers current camera sensors (e.g. 8256×5504). */
export const PROFILE_IMAGE_MAX_PIXELS = 64_000_000;
export const PROFILE_IMAGE_SMALL_SIZE = 96;
export const PROFILE_IMAGE_LARGE_SIZE = 768;
export const PROFILE_IMAGE_CONTENT_TYPE = 'image/webp';
/**
 * Gallery cap, and the only authority for it: the list route reports this as
 * `max_images` and the upload route enforces it, so the client never decides.
 *
 * 100 is bounded by what a gallery costs once stored, not by what a user
 * uploads. Every accepted file is re-encoded to the two WebP variants below and
 * the original (up to PROFILE_IMAGE_MAX_BYTES) is discarded, so the ceiling is the ~400 KB an
 * incompressible source costs at PROFILE_IMAGE_LARGE_SIZE — under 48 MB of blob
 * for a full gallery of pure noise, and nearer 12 MB for real photographs. It
 * also lands on whole rows in the editor's grid at both breakpoints.
 * `profile-image-processing.test.ts` holds both halves of that arithmetic.
 */
export const PROFILE_IMAGE_MAX_GALLERY_ITEMS = 100;

const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

export interface ProcessedImageVariant {
  data: Buffer;
  contentType: typeof PROFILE_IMAGE_CONTENT_TYPE;
  width: number;
  height: number;
}

export interface ProcessedProfileImage {
  small: ProcessedImageVariant;
  large: ProcessedImageVariant;
}

async function renderVariant(input: Buffer, size: number): Promise<ProcessedImageVariant> {
  const rendered = await sharp(input, {
    animated: false,
    failOn: 'warning',
    limitInputPixels: PROFILE_IMAGE_MAX_PIXELS,
  })
    .rotate()
    .resize(size, size, {
      fit: 'cover',
      // Identity photos are commonly portrait-oriented; anchor square crops
      // to the top so faces are preserved instead of trimming the head.
      position: 'north',
      withoutEnlargement: true,
    })
    .webp({ quality: 84, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  if (!rendered.info.width || !rendered.info.height) {
    throw new Error('Image dimensions could not be determined');
  }
  return {
    data: rendered.data,
    contentType: PROFILE_IMAGE_CONTENT_TYPE,
    width: rendered.info.width,
    height: rendered.info.height,
  };
}

/** Decode once for validation, then emit metadata-stripped, bounded WebP variants. */
export async function processProfileImage(input: Buffer): Promise<ProcessedProfileImage> {
  if (input.length === 0) throw new Error('Choose an image to upload');
  if (input.length > PROFILE_IMAGE_MAX_BYTES) {
    throw new Error(`Profile images must be ${PROFILE_IMAGE_MAX_MB} MB or smaller`);
  }
  const metadata = await sharp(input, {
    animated: false,
    failOn: 'warning',
    limitInputPixels: PROFILE_IMAGE_MAX_PIXELS,
  }).metadata();
  if (!metadata.format || !ACCEPTED_FORMATS.has(metadata.format)) {
    throw new Error('Use a JPEG, PNG, or WebP image');
  }
  if (!metadata.width || !metadata.height) throw new Error('Image dimensions are missing');
  if (metadata.width * metadata.height > PROFILE_IMAGE_MAX_PIXELS) {
    throw new Error('Profile image dimensions are too large');
  }
  const [small, large] = await Promise.all([
    renderVariant(input, PROFILE_IMAGE_SMALL_SIZE),
    renderVariant(input, PROFILE_IMAGE_LARGE_SIZE),
  ]);
  return { small, large };
}

export function sanitizeProfileImageName(value: unknown): string {
  if (typeof value !== 'string') return 'profile-image';
  const clean = value
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim();
  return clean.slice(0, 180) || 'profile-image';
}

export function sanitizeProfileImageAlt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim();
  return clean ? clean.slice(0, 240) : undefined;
}
