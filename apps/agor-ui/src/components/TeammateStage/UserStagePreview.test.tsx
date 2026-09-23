import type { ProfileImage, User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useProfileIdentityModel,
  useProfileImageGallery,
  useProfileImageUrl,
} from '../ProfileImage';
import { UserStagePreview } from './UserStagePreview';

vi.mock('../ProfileImage', () => ({
  useProfileIdentityModel: vi.fn(),
  useProfileImageGallery: vi.fn(),
  useProfileImageUrl: vi.fn(),
}));

const user = {
  user_id: 'user-1',
  name: 'Avery Chen',
  email: 'avery@example.com',
  profile_image_id: 'image-1',
} as User;
const image = {
  image_id: 'image-1',
  subject_type: 'user',
  subject_id: 'user-1',
  is_primary: true,
  position: 0,
} as ProfileImage;

describe('UserStagePreview', () => {
  beforeEach(() => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      display: 'block',
      visibility: 'visible',
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration);
  });

  afterEach(() => vi.restoreAllMocks());

  it('reveals the selected gallery image and generation controls on demand', async () => {
    vi.mocked(useProfileImageGallery).mockReturnValue([image]);
    vi.mocked(useProfileImageUrl).mockReturnValue('blob:user-profile');
    vi.mocked(useProfileIdentityModel).mockReturnValue({
      image,
      identityModel: undefined,
      modelUrl: undefined,
      generating: false,
      error: undefined,
      generate: vi.fn(),
    });

    render(
      <ConfigProvider>
        <App>
          <UserStagePreview user={user} />
        </App>
      </ConfigProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'View 3D stage' }));
    expect(await screen.findByAltText('Avery Chen source profile')).toHaveAttribute(
      'src',
      'blob:user-profile'
    );
    expect(screen.getByRole('button', { name: /Generate 3D model/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide 3D stage' })).toBeVisible();
  });
});
