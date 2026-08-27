import type { Branch, ProfileImage } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { TeammateBoardPortrait } from './TeammateBoardPortrait';
import { useProfileImageGallery } from './useProfileImageGallery';
import { useProfileImageUrl } from './useProfileImageUrl';

vi.mock('./useProfileImageGallery', () => ({ useProfileImageGallery: vi.fn() }));
vi.mock('./useProfileImageUrl', () => ({ useProfileImageUrl: vi.fn() }));

const branch = {
  branch_id: 'branch-1',
  custom_context: {
    teammate: {
      kind: 'teammate',
      displayName: 'Ada',
      emoji: '🎨',
      profileImageId: 'image-main',
    },
  },
} as unknown as Branch;

function image(id: string, position: number, primary = false): ProfileImage {
  return {
    image_id: id,
    subject_type: 'teammate',
    subject_id: branch.branch_id,
    created_by: 'user-1',
    original_name: `${id}.webp`,
    position,
    is_primary: primary,
    small_width: 128,
    small_height: 128,
    large_width: 768,
    large_height: 768,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('TeammateBoardPortrait', () => {
  it('renders a large square main portrait and up to three alternate photos', () => {
    vi.mocked(useProfileImageGallery).mockReturnValue([
      image('image-main', 0, true),
      image('image-two', 1),
      image('image-three', 2),
      image('image-four', 3),
      image('image-five', 4),
    ]);
    vi.mocked(useProfileImageUrl).mockImplementation((imageId) =>
      imageId ? `blob:${imageId}` : undefined
    );

    render(
      <ConfigProvider>
        <TeammateBoardPortrait branch={branch} />
      </ConfigProvider>
    );

    expect(screen.getByTestId('teammate-board-portrait')).toBeVisible();
    expect(screen.getByTitle('3 alternate teammate photos')).toBeVisible();
    expect(screen.getByAltText('image-two.webp')).toBeVisible();
    expect(screen.getByAltText('image-three.webp')).toBeVisible();
    expect(screen.getByAltText('image-four.webp')).toBeVisible();
    expect(screen.queryByAltText('image-five.webp')).not.toBeInTheDocument();
  });
});
