import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProfileImageBlob } from './profileImageApi';
import { useProfileImageUrl } from './useProfileImageUrl';

vi.mock('./profileImageApi', () => ({ fetchProfileImageBlob: vi.fn() }));

describe('useProfileImageUrl', () => {
  beforeEach(() => {
    vi.mocked(fetchProfileImageBlob).mockReset();
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) =>
      blob.size === 1 ? 'blob:first' : 'blob:second'
    );
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  it('keeps the previous gallery frame until the next image has loaded', async () => {
    let resolveSecond: ((blob: Blob) => void) | undefined;
    vi.mocked(fetchProfileImageBlob)
      .mockResolvedValueOnce(new Blob(['1']))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          })
      );
    const { result, rerender } = renderHook(
      ({ imageId }) => useProfileImageUrl(imageId, 'small', 'teammate:one'),
      { initialProps: { imageId: 'image-one' } }
    );

    await waitFor(() => expect(result.current).toBe('blob:first'));
    rerender({ imageId: 'image-two' });
    expect(result.current).toBe('blob:first');

    resolveSecond?.(new Blob(['22']));
    await waitFor(() => expect(result.current).toBe('blob:second'));
  });

  it('never carries an old image across different identity subjects', async () => {
    vi.mocked(fetchProfileImageBlob)
      .mockResolvedValueOnce(new Blob(['1']))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const { result, rerender } = renderHook(
      ({ imageId, continuityKey }) => useProfileImageUrl(imageId, 'small', continuityKey),
      { initialProps: { imageId: 'image-one', continuityKey: 'user:one' } }
    );

    await waitFor(() => expect(result.current).toBe('blob:first'));
    rerender({ imageId: 'image-two', continuityKey: 'user:two' });
    expect(result.current).toBeUndefined();
  });
});
