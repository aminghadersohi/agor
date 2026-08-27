import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  PROFILE_IMAGE_CONTENT_TYPE,
  PROFILE_IMAGE_LARGE_SIZE,
  PROFILE_IMAGE_SMALL_SIZE,
  processProfileImage,
  sanitizeProfileImageAlt,
  sanitizeProfileImageName,
} from './profile-image-processing.js';

async function fixture(width = 1200, height = 800): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 24, g: 110, b: 90 },
    },
  })
    .jpeg({ quality: 90 })
    .withMetadata({ comment: 'must not survive processing' })
    .toBuffer();
}

describe('processProfileImage', () => {
  it('emits bounded square WebP variants and strips source metadata', async () => {
    const result = await processProfileImage(await fixture());

    expect(result.small).toMatchObject({
      contentType: PROFILE_IMAGE_CONTENT_TYPE,
      width: PROFILE_IMAGE_SMALL_SIZE,
      height: PROFILE_IMAGE_SMALL_SIZE,
    });
    expect(result.large).toMatchObject({
      contentType: PROFILE_IMAGE_CONTENT_TYPE,
      width: PROFILE_IMAGE_LARGE_SIZE,
      height: PROFILE_IMAGE_LARGE_SIZE,
    });

    for (const variant of [result.small, result.large]) {
      const metadata = await sharp(variant.data).metadata();
      expect(metadata.format).toBe('webp');
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
    }
  });

  it('does not enlarge a source smaller than the requested variants', async () => {
    const result = await processProfileImage(await fixture(40, 24));

    expect(result.small.width).toBeLessThanOrEqual(PROFILE_IMAGE_SMALL_SIZE);
    expect(result.small.height).toBeLessThanOrEqual(PROFILE_IMAGE_SMALL_SIZE);
    expect(result.large.width).toBeLessThanOrEqual(PROFILE_IMAGE_LARGE_SIZE);
    expect(result.large.height).toBeLessThanOrEqual(PROFILE_IMAGE_LARGE_SIZE);
  });

  it("anchors portrait crops to the top where a subject's head is expected", async () => {
    const portrait = await sharp(
      Buffer.from(`
        <svg width="100" height="300" xmlns="http://www.w3.org/2000/svg">
          <rect width="100" height="100" y="0" fill="#ff0000" />
          <rect width="100" height="100" y="100" fill="#00ff00" />
          <rect width="100" height="100" y="200" fill="#0000ff" />
        </svg>
      `)
    )
      .png()
      .toBuffer();

    const result = await processProfileImage(portrait);
    const centerPixel = await sharp(result.small.data)
      .removeAlpha()
      .extract({
        left: Math.floor(result.small.width / 2),
        top: Math.floor(result.small.height / 2),
        width: 1,
        height: 1,
      })
      .raw()
      .toBuffer();

    expect(centerPixel[0]).toBeGreaterThan(200);
    expect(centerPixel[1]).toBeLessThan(40);
    expect(centerPixel[2]).toBeLessThan(40);
  });

  it('rejects unsupported and empty input', async () => {
    await expect(processProfileImage(Buffer.alloc(0))).rejects.toThrow(/choose an image/i);
    await expect(processProfileImage(Buffer.from('<svg/>'))).rejects.toThrow();
  });
});

describe('profile image text sanitizers', () => {
  it('removes control characters and bounds persisted strings', () => {
    expect(sanitizeProfileImageName(`  avatar\u0000name.jpg  `)).toBe('avatarname.jpg');
    expect(sanitizeProfileImageAlt('  Product\u0007 owner  ')).toBe('Product  owner');
    expect(sanitizeProfileImageName('x'.repeat(300))).toHaveLength(180);
    expect(sanitizeProfileImageAlt('y'.repeat(300))).toHaveLength(240);
  });
});
