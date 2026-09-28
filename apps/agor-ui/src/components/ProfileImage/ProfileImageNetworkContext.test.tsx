import { renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProfileImageNetworkProvider } from './ProfileImageNetworkContext';
import { fetchProfileImageBlob, listProfileImages } from './profileImageApi';
import { useProfileImageGallery } from './useProfileImageGallery';
import { useProfileImageUrl } from './useProfileImageUrl';

vi.mock('./profileImageApi', () => ({
  listProfileImages: vi.fn().mockResolvedValue({ images: [] }),
  fetchProfileImageBlob: vi.fn(),
}));

describe('static profile-image network boundary', () => {
  it('does not fetch gallery metadata or projected images for static surfaces', async () => {
    const wrapper = ({ children }: PropsWithChildren) => (
      <ProfileImageNetworkProvider value={false}>{children}</ProfileImageNetworkProvider>
    );
    const { result } = renderHook(
      () => ({
        images: useProfileImageGallery({ type: 'user', id: 'fictional-user' }),
        url: useProfileImageUrl('fictional-image', 'small'),
      }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.images).toEqual([]));
    expect(result.current.url).toBeUndefined();
    expect(listProfileImages).not.toHaveBeenCalled();
    expect(fetchProfileImageBlob).not.toHaveBeenCalled();
  });
});
