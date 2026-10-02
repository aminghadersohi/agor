import type { ProfileImage } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileImageGalleryEditor, validateProfileImageFile } from './ProfileImageGalleryEditor';
import {
  bulkDeleteProfileImages,
  bulkSetProfileImageTheme,
  deleteProfileImage,
  listProfileImages,
  patchProfileImage,
  reorderProfileImages,
  setTeammateActiveTheme,
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
    reorderProfileImages: vi.fn(),
    bulkDeleteProfileImages: vi.fn(),
    bulkSetProfileImageTheme: vi.fn(),
    setTeammateActiveTheme: vi.fn(),
  };
});

vi.mock('./useProfileImageUrl', () => ({
  useProfileImageUrl: (imageId?: string | null) => (imageId ? `blob:${imageId}` : undefined),
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
    vi.mocked(reorderProfileImages).mockReset();
    vi.mocked(bulkDeleteProfileImages).mockReset();
    vi.mocked(bulkSetProfileImageTheme).mockReset();
    vi.mocked(setTeammateActiveTheme).mockReset();
  });

  afterEach(() => {
    computedStyleSpy.mockRestore();
  });

  const thumbnails = () => screen.getAllByTestId('profile-image-thumbnail');

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
    expect(screen.getByTestId('profile-image-count')).toHaveTextContent('2 / 8');
    fireEvent.click(screen.getByLabelText('Set second.webp as main photo'));
    await waitFor(() =>
      expect(patchProfileImage).toHaveBeenCalledWith('image-2', { is_primary: true })
    );
    expect(onPrimaryChange).toHaveBeenCalledWith('image-2');
  });

  it('opens a larger preview that pages through the gallery and keeps removal behind confirmation', async () => {
    renderEditor(
      <ProfileImageGalleryEditor
        subject={{ type: 'user', id: 'user-1' }}
        canEdit
        label="Profile photos"
      />
    );
    await screen.findByText('Main');
    fireEvent.click(screen.getByLabelText('Open first.webp'));
    expect(await screen.findByText('first.webp (1 of 2)')).toBeVisible();

    fireEvent.click(screen.getByLabelText('Next photo'));
    expect(await screen.findByText('second.webp (2 of 2)')).toBeVisible();

    fireEvent.click(screen.getByText('Remove photo'));
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
    expect(screen.queryByText('Add images')).toBeNull();
    expect(screen.queryByLabelText('Set second.webp as main photo')).toBeNull();
    expect(screen.queryByLabelText('Select first.webp')).toBeNull();
    expect(screen.queryByText('Select all')).toBeNull();
    expect(thumbnails()[0]).toHaveAttribute('draggable', 'false');
  });

  it('offers a drop zone when the gallery is empty and a plain message when read-only', async () => {
    vi.mocked(listProfileImages).mockResolvedValue({ images: [], max_images: 8 });
    const { unmount } = renderEditor(
      <ProfileImageGalleryEditor
        subject={{ type: 'user', id: 'user-1' }}
        canEdit
        label="Profile photos"
      />
    );
    expect(
      await screen.findByText('Add images: drop photos here, or click to choose')
    ).toBeVisible();
    unmount();

    renderEditor(
      <ProfileImageGalleryEditor
        subject={{ type: 'user', id: 'user-1' }}
        canEdit={false}
        label="Profile photos"
      />
    );
    expect(await screen.findByText('No image')).toBeVisible();
  });

  it('shows a retry when the gallery cannot load', async () => {
    vi.mocked(listProfileImages).mockRejectedValueOnce(new Error('daemon down'));
    renderEditor(
      <ProfileImageGalleryEditor
        subject={{ type: 'user', id: 'user-1' }}
        canEdit
        label="Profile photos"
      />
    );
    expect(await screen.findByText('daemon down')).toBeVisible();
    fireEvent.click(screen.getByText('Retry'));
    expect(await screen.findByText('Main')).toBeVisible();
  });

  it('uploads multiple selected images sequentially with progress and refreshes once', async () => {
    vi.mocked(uploadProfileImage)
      .mockImplementationOnce(async (_subject, _file, options) => {
        options?.onProgress?.(0.5);
        return { ...images[0], image_id: 'image-3', is_primary: false };
      })
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
    expect(vi.mocked(uploadProfileImage).mock.calls[0][2]?.onProgress).toBeTypeOf('function');
    await waitFor(() => expect(listProfileImages).toHaveBeenCalledTimes(2));
  });

  it('keeps failed uploads in the queue and retries only them', async () => {
    vi.mocked(uploadProfileImage)
      .mockRejectedValueOnce(new Error('Too big for the daemon'))
      .mockResolvedValueOnce({ ...images[0], image_id: 'image-3', is_primary: false })
      .mockResolvedValueOnce({ ...images[0], image_id: 'image-4', is_primary: false });
    renderEditor(
      <ProfileImageGalleryEditor
        subject={{ type: 'user', id: 'user-1' }}
        canEdit
        label="Profile photos"
      />
    );
    await screen.findByText('Main');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          new File(['a'], 'bad.png', { type: 'image/png' }),
          new File(['b'], 'good.png', { type: 'image/png' }),
        ],
      },
    });

    expect(await screen.findByText('1 upload failed')).toBeVisible();
    expect(
      screen.getByText('Too big for the daemon', { selector: '.ant-typography' })
    ).toBeVisible();
    fireEvent.click(screen.getByText('Retry failed'));

    await waitFor(() => expect(uploadProfileImage).toHaveBeenCalledTimes(3));
    expect(vi.mocked(uploadProfileImage).mock.calls[2][1].name).toBe('bad.png');
    await waitFor(() => expect(screen.queryByTestId('profile-image-upload-queue')).toBeNull());
  });

  it('uploads files dropped onto the grid but ignores in-gallery tile drags', async () => {
    vi.mocked(uploadProfileImage).mockResolvedValue({
      ...images[0],
      image_id: 'image-3',
      is_primary: false,
    });
    renderEditor(
      <ProfileImageGalleryEditor
        subject={{ type: 'user', id: 'user-1' }}
        canEdit
        label="Profile photos"
      />
    );
    await screen.findByText('Main');
    const zone = thumbnails()[0].parentElement?.parentElement as HTMLElement;
    const dropped = new File(['x'], 'dropped.png', { type: 'image/png' });

    fireEvent.dragEnter(zone, { dataTransfer: { types: ['Files'], files: [dropped] } });
    expect(await screen.findByText('Drop to add photos')).toBeVisible();
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [dropped] } });

    await waitFor(() => expect(uploadProfileImage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(uploadProfileImage).mock.calls[0][1].name).toBe('dropped.png');

    vi.mocked(uploadProfileImage).mockClear();
    fireEvent.drop(zone, { dataTransfer: { types: ['text/plain'], files: [] } });
    expect(uploadProfileImage).not.toHaveBeenCalled();
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
      expect.objectContaining({ name: 'first.png' }),
      expect.anything()
    );
  });

  // Reached through its label rather than by role: this file mocks
  // getComputedStyle globally, which defeats accessible-name computation.
  const uploadButton = () => screen.getByText('Add images').closest('button');

  // The cap the user sees has to be the one the server enforces, so these drive
  // it from the response rather than from the component's pre-fetch placeholder.
  it('states the cap the server reports rather than its own default', async () => {
    vi.mocked(listProfileImages).mockResolvedValue({ images, max_images: 30 });
    renderEditor(
      <ProfileImageGalleryEditor
        subject={{ type: 'user', id: 'user-1' }}
        canEdit
        label="Profile photos"
      />
    );

    expect(await screen.findByText(/keep up to 30 total/)).toBeVisible();
    expect(uploadButton()).toBeEnabled();
  });

  it('disables uploading and names the cap once a raised gallery is full', async () => {
    const full = Array.from({ length: 30 }, (_, index) => ({
      ...images[0],
      image_id: `image-${index}`,
      original_name: `photo-${index}.webp`,
      position: index,
      is_primary: index === 0,
    }));
    vi.mocked(listProfileImages).mockResolvedValue({ images: full, max_images: 30 });
    renderEditor(
      <ProfileImageGalleryEditor
        subject={{ type: 'user', id: 'user-1' }}
        canEdit
        label="Profile photos"
      />
    );

    expect(await screen.findByText('Main')).toBeVisible();
    expect(thumbnails()).toHaveLength(30);
    expect(uploadButton()).toBeDisabled();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'extra.png', { type: 'image/png' })] },
    });

    expect(await screen.findByText('This gallery already has 30 images')).toBeVisible();
    expect(uploadProfileImage).not.toHaveBeenCalled();
  });

  describe('reordering', () => {
    it('reorders optimistically on drop and persists the new order', async () => {
      vi.mocked(reorderProfileImages).mockResolvedValue({
        images: [
          { ...images[1], position: 0 },
          { ...images[0], position: 1 },
        ],
        max_images: 8,
      });
      renderEditor(
        <ProfileImageGalleryEditor
          subject={{ type: 'user', id: 'user-1' }}
          canEdit
          label="Profile photos"
        />
      );
      await screen.findByText('Main');
      const [first, second] = thumbnails();
      const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '', types: [] };

      fireEvent.dragStart(second, { dataTransfer });
      fireEvent.dragOver(first, { dataTransfer });
      fireEvent.drop(first, { dataTransfer });

      await waitFor(() =>
        expect(reorderProfileImages).toHaveBeenCalledWith({ type: 'user', id: 'user-1' }, [
          'image-2',
          'image-1',
        ])
      );
      expect(thumbnails().map((tile) => tile.getAttribute('data-image-id'))).toEqual([
        'image-2',
        'image-1',
      ]);
    });

    it('restores the server order when persisting fails', async () => {
      vi.mocked(reorderProfileImages).mockRejectedValue(new Error('conflict'));
      renderEditor(
        <ProfileImageGalleryEditor
          subject={{ type: 'user', id: 'user-1' }}
          canEdit
          label="Profile photos"
        />
      );
      await screen.findByText('Main');
      const [first, second] = thumbnails();
      const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '', types: [] };
      fireEvent.dragStart(second, { dataTransfer });
      fireEvent.drop(first, { dataTransfer });

      expect(await screen.findByText('conflict')).toBeVisible();
      await waitFor(() =>
        expect(thumbnails().map((tile) => tile.getAttribute('data-image-id'))).toEqual([
          'image-1',
          'image-2',
        ])
      );
    });

    it('moves a photo earlier from the preview without dragging', async () => {
      vi.mocked(reorderProfileImages).mockResolvedValue({ images, max_images: 8 });
      renderEditor(
        <ProfileImageGalleryEditor
          subject={{ type: 'user', id: 'user-1' }}
          canEdit
          label="Profile photos"
        />
      );
      await screen.findByText('Main');
      fireEvent.click(screen.getByLabelText('Open second.webp'));
      fireEvent.click(await screen.findByText('Move earlier'));
      await waitFor(() =>
        expect(reorderProfileImages).toHaveBeenCalledWith({ type: 'user', id: 'user-1' }, [
          'image-2',
          'image-1',
        ])
      );
    });
  });

  describe('selection and bulk actions', () => {
    const themed: ProfileImage[] = [
      { ...images[0], subject_type: 'teammate', subject_id: 'branch-1', theme: 'Winter' },
      { ...images[1], subject_type: 'teammate', subject_id: 'branch-1' },
      {
        ...images[1],
        image_id: 'image-3',
        original_name: 'third.webp',
        position: 2,
        subject_type: 'teammate',
        subject_id: 'branch-1',
        theme: 'summer',
      },
    ];

    const renderTeammate = (props: { activeTheme?: string; canEdit?: boolean } = {}) =>
      renderEditor(
        <ProfileImageGalleryEditor
          subject={{ type: 'teammate', id: 'branch-1' }}
          canEdit={props.canEdit ?? true}
          label="Teammate photos"
          activeTheme={props.activeTheme}
        />
      );

    beforeEach(() => {
      vi.mocked(listProfileImages).mockResolvedValue({ images: themed, max_images: 8 });
    });

    it('selects photos, selects all, and clears the selection', async () => {
      renderTeammate();
      await screen.findByText('Main');
      expect(screen.queryByTestId('profile-image-bulk-bar')).toBeNull();

      fireEvent.click(screen.getByLabelText('Select first.webp'));
      expect(screen.getByText('1 selected')).toBeVisible();
      fireEvent.click(screen.getByText('Select all'));
      expect(screen.getByText('3 selected')).toBeVisible();
      fireEvent.click(screen.getByText('Clear selection'));
      expect(screen.queryByTestId('profile-image-bulk-bar')).toBeNull();
    });

    it('labels every selected photo with a typed theme', async () => {
      vi.mocked(bulkSetProfileImageTheme).mockResolvedValue({
        images: themed.map((image) => ({ ...image, theme: 'Holiday' })),
        max_images: 8,
      });
      renderTeammate();
      await screen.findByText('Main');
      fireEvent.click(screen.getByLabelText('Select first.webp'));
      fireEvent.click(screen.getByLabelText('Select second.webp'));

      fireEvent.change(screen.getByLabelText('Theme for selected photos'), {
        target: { value: '  Holiday ' },
      });
      fireEvent.click(screen.getByText('Apply'));

      await waitFor(() =>
        expect(bulkSetProfileImageTheme).toHaveBeenCalledWith(
          { type: 'teammate', id: 'branch-1' },
          ['image-1', 'image-2'],
          'Holiday'
        )
      );
      await waitFor(() => expect(screen.queryByTestId('profile-image-bulk-bar')).toBeNull());
    });

    it('clears the theme on selected photos', async () => {
      vi.mocked(bulkSetProfileImageTheme).mockResolvedValue({ images: themed, max_images: 8 });
      renderTeammate();
      await screen.findByText('Main');
      fireEvent.click(screen.getByLabelText('Select first.webp'));
      fireEvent.click(screen.getByText('Clear theme'));
      await waitFor(() =>
        expect(bulkSetProfileImageTheme).toHaveBeenCalledWith(
          { type: 'teammate', id: 'branch-1' },
          ['image-1'],
          null
        )
      );
    });

    it('deletes selected photos only after confirmation and reports the new main photo', async () => {
      const onPrimaryChange = vi.fn();
      vi.mocked(bulkDeleteProfileImages).mockResolvedValue({
        images: [{ ...themed[2], is_primary: true, position: 0 }],
        max_images: 8,
      });
      renderEditor(
        <ProfileImageGalleryEditor
          subject={{ type: 'teammate', id: 'branch-1' }}
          canEdit
          label="Teammate photos"
          onPrimaryChange={onPrimaryChange}
        />
      );
      await screen.findByText('Main');
      fireEvent.click(screen.getByLabelText('Select first.webp'));
      fireEvent.click(screen.getByLabelText('Select second.webp'));

      fireEvent.click(screen.getByText('Remove'));
      expect(bulkDeleteProfileImages).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

      await waitFor(() =>
        expect(bulkDeleteProfileImages).toHaveBeenCalledWith({ type: 'teammate', id: 'branch-1' }, [
          'image-1',
          'image-2',
        ])
      );
      await waitFor(() => expect(onPrimaryChange).toHaveBeenCalledWith('image-3'));
      await waitFor(() => expect(thumbnails()).toHaveLength(1));
    });

    it('does not offer theme labelling outside teammate galleries', async () => {
      renderEditor(
        <ProfileImageGalleryEditor
          subject={{ type: 'user', id: 'user-1' }}
          canEdit
          label="Profile photos"
        />
      );
      await screen.findByText('Main');
      fireEvent.click(screen.getByLabelText('Select first.webp'));
      expect(screen.queryByTestId('profile-image-theme-picker')).toBeNull();
      expect(screen.queryByLabelText('Theme for selected photos')).toBeNull();
      expect(screen.queryByLabelText('Theme for new photos')).toBeNull();
    });
  });

  describe('active theme', () => {
    const themed: ProfileImage[] = [
      { ...images[0], subject_type: 'teammate', subject_id: 'branch-1', theme: 'Winter' },
      { ...images[1], subject_type: 'teammate', subject_id: 'branch-1', theme: 'winter' },
      {
        ...images[1],
        image_id: 'image-3',
        original_name: 'third.webp',
        position: 2,
        subject_type: 'teammate',
        subject_id: 'branch-1',
        theme: 'Summer',
      },
    ];
    const renderTeammate = (activeTheme?: string, canEdit = true) =>
      renderEditor(
        <ProfileImageGalleryEditor
          subject={{ type: 'teammate', id: 'branch-1' }}
          canEdit={canEdit}
          label="Teammate photos"
          activeTheme={activeTheme}
        />
      );

    beforeEach(() => {
      vi.mocked(listProfileImages).mockResolvedValue({ images: themed, max_images: 8 });
    });

    it('lists the gallery themes with counts, merging spellings that differ only by case', async () => {
      renderTeammate();
      expect(await screen.findByText('All (3)')).toBeVisible();
      expect(screen.getByText('Winter (2)')).toBeVisible();
      expect(screen.getByText('Summer (1)')).toBeVisible();
    });

    it('persists a chosen theme and returns to All', async () => {
      vi.mocked(setTeammateActiveTheme)
        .mockResolvedValueOnce({ active_theme: 'Winter' })
        .mockResolvedValueOnce({ active_theme: null });
      renderTeammate();
      fireEvent.click(await screen.findByText('Winter (2)'));
      await waitFor(() =>
        expect(setTeammateActiveTheme).toHaveBeenLastCalledWith('branch-1', 'Winter')
      );
      expect(await screen.findByText(/Only the 2 “Winter” photos appear on avatars/)).toBeVisible();

      fireEvent.click(screen.getByText('All (3)'));
      await waitFor(() =>
        expect(setTeammateActiveTheme).toHaveBeenLastCalledWith('branch-1', null)
      );
    });

    it('rolls the choice back and says so when the daemon refuses it', async () => {
      vi.mocked(setTeammateActiveTheme).mockRejectedValue(new Error('Profile unavailable'));
      renderTeammate();
      fireEvent.click(await screen.findByText('Summer (1)'));
      expect(await screen.findByText('Profile unavailable')).toBeVisible();
      expect(screen.getByText('All (3)').closest('.ant-tag-checkable-checked')).not.toBeNull();
    });

    it('dims photos outside the active theme and explains an empty theme', async () => {
      const { unmount } = renderTeammate('Summer');
      await screen.findByText('Main');
      const opacity = () => thumbnails().map((tile) => tile.style.opacity);
      expect(opacity()).toEqual(['0.45', '0.45', '1']);
      unmount();

      renderTeammate('Autumn');
      expect(
        await screen.findByText('No photos use “Autumn”, so every photo is used.')
      ).toBeVisible();
      expect(thumbnails().every((tile) => tile.style.opacity === '1')).toBe(true);
    });

    it('does not let read-only viewers change the active theme', async () => {
      renderTeammate(undefined, false);
      fireEvent.click(await screen.findByText('Winter (2)'));
      expect(setTeammateActiveTheme).not.toHaveBeenCalled();
    });

    it('labels new uploads with the theme typed beside the upload control', async () => {
      vi.mocked(uploadProfileImage).mockResolvedValue({ ...themed[0], image_id: 'image-9' });
      renderTeammate();
      await screen.findByText('Main');
      fireEvent.change(screen.getByLabelText('Theme for new photos'), {
        target: { value: ' Holiday ' },
      });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'new.png', { type: 'image/png' })] },
      });
      await waitFor(() => expect(uploadProfileImage).toHaveBeenCalledTimes(1));
      expect(vi.mocked(uploadProfileImage).mock.calls[0][2]?.theme).toBe('Holiday');
    });

    it('edits a photo theme from the preview, and clears it when emptied', async () => {
      vi.mocked(patchProfileImage).mockResolvedValue({ ...themed[2], theme: 'Holiday' });
      renderTeammate();
      await screen.findByText('Main');
      fireEvent.click(screen.getByLabelText('Open third.webp'));
      const field = await screen.findByLabelText('Photo theme');
      fireEvent.change(field, { target: { value: 'Holiday' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      await waitFor(() =>
        expect(patchProfileImage).toHaveBeenLastCalledWith('image-3', { theme: 'Holiday' })
      );

      await waitFor(() => expect(field).toBeEnabled());
      fireEvent.change(field, { target: { value: '' } });
      fireEvent.blur(field);
      await waitFor(() =>
        expect(patchProfileImage).toHaveBeenLastCalledWith('image-3', { theme: null })
      );
    });
  });
});

describe('validateProfileImageFile', () => {
  const sized = (bytes: number, type = 'image/jpeg') => {
    const file = new File(['x'], 'photo.jpg', { type });
    Object.defineProperty(file, 'size', { value: bytes });
    return file;
  };

  it('accepts camera-sized uploads up to 25 MB and rejects larger ones', () => {
    expect(validateProfileImageFile(sized(12 * 1024 * 1024))).toBeUndefined();
    expect(validateProfileImageFile(sized(25 * 1024 * 1024))).toBeUndefined();
    expect(validateProfileImageFile(sized(25 * 1024 * 1024 + 1))).toBe(
      'Images must be 25 MB or smaller'
    );
    expect(validateProfileImageFile(sized(10, 'image/gif'))).toBe('Use a JPEG, PNG, or WebP image');
  });
});
