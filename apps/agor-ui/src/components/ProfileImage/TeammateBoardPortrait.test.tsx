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

  it('supports a prominent teammate-panel hero size', () => {
    vi.mocked(useProfileImageGallery).mockReturnValue([image('image-main', 0, true)]);
    vi.mocked(useProfileImageUrl).mockReturnValue('blob:image-main');

    render(
      <ConfigProvider>
        <TeammateBoardPortrait branch={branch} primarySize={300} alternativeSize={40} />
      </ConfigProvider>
    );

    expect(screen.getByTestId('teammate-board-portrait')).toHaveStyle({
      width: '300px',
      height: '300px',
    });
  });

  it('tracks the container in fill mode, capping at the size it is given', () => {
    vi.mocked(useProfileImageGallery).mockReturnValue([image('image-main', 0, true)]);
    vi.mocked(useProfileImageUrl).mockReturnValue('blob:image-main');

    render(
      <ConfigProvider>
        <TeammateBoardPortrait branch={branch} primarySize={768} alternativeSize={44} fill />
      </ConfigProvider>
    );

    const root = screen.getByTestId('teammate-board-portrait');
    // Width follows the container and 768 becomes a ceiling, so no measurement
    // is needed to survive a dragged panel.
    expect(root).toHaveStyle({ width: '100%', maxWidth: '768px' });
    expect(root.style.height).toBe('');
    expect(root.style.containerType).toBe('inline-size');
  });

  it('keeps the alternates strip on the portrait edge in fill mode', () => {
    vi.mocked(useProfileImageGallery).mockReturnValue([
      image('image-main', 0, true),
      image('image-two', 1),
    ]);
    vi.mocked(useProfileImageUrl).mockImplementation((imageId) =>
      imageId ? `blob:${imageId}` : undefined
    );

    render(
      <ConfigProvider>
        <TeammateBoardPortrait branch={branch} primarySize={768} alternativeSize={40} fill />
      </ConfigProvider>
    );

    // The portrait gives up 0.7 alternatives of the container and the strip
    // straddles its edge by a further 0.55, so both are container-relative.
    const strip = screen.getByTitle('1 alternate teammate photo');
    expect(strip).toHaveStyle({ insetInlineStart: 'calc(100% - 50px)' });
    const avatar = document.querySelector('.ant-avatar') as HTMLElement;
    expect(avatar).toHaveStyle({ width: 'calc(100% - 28px)', aspectRatio: '1' });
  });
});
