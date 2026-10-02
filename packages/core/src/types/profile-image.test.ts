import { describe, expect, it } from 'vitest';
import {
  listProfileImageThemes,
  normalizeProfileImageTheme,
  PROFILE_IMAGE_THEME_MAX_LENGTH,
  profileImageThemeKey,
  selectProfileImagesForTheme,
} from './profile-image';

const image = (id: string, theme?: string) => ({ id, theme });

describe('normalizeProfileImageTheme', () => {
  it('trims, collapses whitespace and control characters, and caps the length', () => {
    expect(normalizeProfileImageTheme('  Winter \t Holiday\n')).toBe('Winter Holiday');
    expect(
      normalizeProfileImageTheme('x'.repeat(PROFILE_IMAGE_THEME_MAX_LENGTH + 10))
    ).toHaveLength(PROFILE_IMAGE_THEME_MAX_LENGTH);
  });

  it('treats blank and non-string values as no theme', () => {
    expect(normalizeProfileImageTheme('')).toBeUndefined();
    expect(normalizeProfileImageTheme('   ')).toBeUndefined();
    expect(normalizeProfileImageTheme(null)).toBeUndefined();
    expect(normalizeProfileImageTheme(42)).toBeUndefined();
  });

  it('compares themes case-insensitively', () => {
    expect(profileImageThemeKey(' Winter ')).toBe(profileImageThemeKey('winter'));
  });
});

describe('listProfileImageThemes', () => {
  it('returns distinct themes in first-seen order, keeping the first spelling', () => {
    expect(
      listProfileImageThemes([
        image('1', 'Winter'),
        image('2'),
        image('3', 'summer'),
        image('4', 'winter '),
        image('5', 'Summer'),
      ])
    ).toEqual(['Winter', 'summer']);
  });
});

describe('selectProfileImagesForTheme', () => {
  const gallery = [image('1', 'Winter'), image('2', 'Summer'), image('3'), image('4', 'winter')];

  it('returns the whole gallery when no theme is active', () => {
    expect(selectProfileImagesForTheme(gallery, undefined)).toEqual(gallery);
    expect(selectProfileImagesForTheme(gallery, null)).toEqual(gallery);
    expect(selectProfileImagesForTheme(gallery, '   ')).toEqual(gallery);
  });

  it('keeps only images carrying the active theme, ignoring case and order', () => {
    expect(selectProfileImagesForTheme(gallery, 'WINTER').map((item) => item.id)).toEqual([
      '1',
      '4',
    ]);
  });

  it('falls back to the whole gallery when no image carries the active theme', () => {
    expect(selectProfileImagesForTheme(gallery, 'Autumn')).toEqual(gallery);
    expect(selectProfileImagesForTheme([], 'Winter')).toEqual([]);
  });
});
