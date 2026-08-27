import sharp from 'sharp';

export const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PROFILE_IMAGE_MAX_PIXELS = 25_000_000;
export const PROFILE_IMAGE_SMALL_SIZE = 96;
export const PROFILE_IMAGE_LARGE_SIZE = 768;
export const PROFILE_IMAGE_CONTENT_TYPE = 'image/webp';
export const PROFILE_IMAGE_MAX_GALLERY_ITEMS = 8;

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
    throw new Error('Profile images must be 5 MB or smaller');
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
