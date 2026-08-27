import type { User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUserProfileImageUrl } from '../ProfileImage';
import { UserStagePreview } from './UserStagePreview';

vi.mock('../ProfileImage', () => ({ useUserProfileImageUrl: vi.fn() }));

const user = {
  user_id: 'user-1',
  name: 'Avery Chen',
  email: 'avery@example.com',
} as User;

describe('UserStagePreview', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reveals a private profile-image stage on demand', async () => {
    vi.mocked(useUserProfileImageUrl).mockReturnValue('blob:user-profile');
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      display: 'block',
      visibility: 'visible',
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);

    render(
      <ConfigProvider>
        <UserStagePreview user={user} />
      </ConfigProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'View 3D stage' }));
    expect(await screen.findByAltText('Avery Chen profile')).toHaveAttribute(
      'src',
      'blob:user-profile'
    );
    expect(screen.getByText('Local rendering')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide 3D stage' })).toBeVisible();
  });
});
