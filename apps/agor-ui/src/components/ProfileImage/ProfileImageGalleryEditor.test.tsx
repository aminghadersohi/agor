import type { ProfileImage } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileImageGalleryEditor } from './ProfileImageGalleryEditor';
import {
  deleteProfileImage,
  listProfileImages,
  patchProfileImage,
  uploadProfileImage,
} from './profileImageApi';

vi.mock('./profileImageApi', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('./profileImageApi')>();
  return {
    ...original,
    listProfileImages: vi.fn(),
    uploadProfileImage: vi.fn(),
    patchProfileImage: vi.fn(),
    deleteProfileImage: vi.fn(),
  };
});

vi.mock('./ProfileImagePreview', () => ({
  ProfileImagePreview: ({ alt }: { alt?: string }) => <img alt={alt} />,
}));

const images: ProfileImage[] = [
  {
    image_id: 'image-1',
    subject_type: 'user',
    subject_id: 'user-1',
    created_by: 'user-1',
    original_name: 'first.webp',
    position: 0,
    is_primary: true,
    small_width: 96,
    small_height: 96,
    large_width: 768,
    large_height: 768,
    created_at: '2026-08-25T00:00:00.000Z',
    updated_at: '2026-08-25T00:00:00.000Z',
  },
  {
    image_id: 'image-2',
    subject_type: 'user',
    subject_id: 'user-1',
    created_by: 'user-1',
    original_name: 'second.webp',
    position: 1,
    is_primary: false,
    small_width: 96,
    small_height: 96,
    large_width: 768,
    large_height: 768,
    created_at: '2026-08-25T00:00:00.000Z',
    updated_at: '2026-08-25T00:00:00.000Z',
  },
];

function renderEditor(ui: ReactNode) {
  return render(
    <ConfigProvider theme={{ cssVar: false }}>
      <App>{ui}</App>
    </ConfigProvider>
  );
}

describe('ProfileImageGalleryEditor', () => {
  let computedStyleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    computedStyleSpy = vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      display: 'block',
      visibility: 'visible',
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration);
    vi.mocked(listProfileImages).mockReset().mockResolvedValue({ images, max_images: 8 });
    vi.mocked(patchProfileImage)
      .mockReset()
      .mockResolvedValue({ ...images[1], is_primary: true });
    vi.mocked(deleteProfileImage).mockReset().mockResolvedValue();
    vi.mocked(uploadProfileImage).mockReset();
  });

  afterEach(() => {
    computedStyleSpy.mockRestore();
  });

  it('loads a private gallery and switches the main photo', async () => {
    const onPrimaryChange = vi.fn();
    renderEditor(
      <ProfileImageGalleryEditor
        subject={{ type: 'user', id: 'user-1' }}
        canEdit
        label="Profile photos"
        onPrimaryChange={onPrimaryChange}
      />
    );

    expect(await screen.findByText('Main')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Use/ }));
    await waitFor(() =>
      expect(patchProfileImage).toHaveBeenCalledWith('image-2', { is_primary: true })
    );
    expect(onPrimaryChange).toHaveBeenCalledWith('image-2');
  });

  it('keeps destructive photo removal behind confirmation', async () => {
    renderEditor(
      <ProfileImageGalleryEditor
        subject={{ type: 'user', id: 'user-1' }}
        canEdit
        label="Profile photos"
      />
    );
    await screen.findByText('Main');
    fireEvent.click(screen.getByRole('button', { name: 'Remove second.webp' }));
    expect(deleteProfileImage).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(deleteProfileImage).toHaveBeenCalledWith('image-2'));
  });

  it('renders a read-only gallery without mutation controls', async () => {
    renderEditor(
      <ProfileImageGalleryEditor
        subject={{ type: 'teammate', id: 'branch-1' }}
        canEdit={false}
        label="Teammate photos"
      />
    );
    expect(await screen.findByText('Main')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add images' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use' })).toBeNull();
  });

  it('uploads multiple selected images sequentially and refreshes once', async () => {
    vi.mocked(uploadProfileImage)
      .mockResolvedValueOnce({ ...images[0], image_id: 'image-3', is_primary: false })
      .mockResolvedValueOnce({ ...images[1], image_id: 'image-4', is_primary: false });
    renderEditor(
      <ProfileImageGalleryEditor
        subject={{ type: 'user', id: 'user-1' }}
        canEdit
        label="Profile photos"
      />
    );
    await screen.findByText('Main');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const first = new File(['first'], 'first.png', { type: 'image/png' });
    const second = new File(['second'], 'second.webp', { type: 'image/webp' });

    fireEvent.change(input, { target: { files: [first, second] } });

    await waitFor(() => expect(uploadProfileImage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(uploadProfileImage).mock.calls.map((call) => call[1].name)).toEqual([
      'first.png',
      'second.webp',
    ]);
    expect(listProfileImages).toHaveBeenCalledTimes(2);
  });

  it('uploads only the files that fit in the remaining gallery slots', async () => {
    vi.mocked(listProfileImages).mockResolvedValue({ images, max_images: 3 });
    vi.mocked(uploadProfileImage).mockResolvedValue({
      ...images[0],
      image_id: 'image-3',
      is_primary: false,
    });
    renderEditor(
      <ProfileImageGalleryEditor
        subject={{ type: 'board', id: 'board-1' }}
        canEdit
        label="Board photos"
      />
    );
    await screen.findByText('Main');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const first = new File(['first'], 'first.png', { type: 'image/png' });
    const second = new File(['second'], 'second.png', { type: 'image/png' });

    fireEvent.change(input, { target: { files: [first, second] } });

    await waitFor(() => expect(uploadProfileImage).toHaveBeenCalledTimes(1));
    expect(uploadProfileImage).toHaveBeenCalledWith(
      { type: 'board', id: 'board-1' },
      expect.objectContaining({ name: 'first.png' })
    );
  });
});
