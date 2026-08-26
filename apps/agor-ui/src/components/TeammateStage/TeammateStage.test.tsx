import { render, screen } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeammateStage } from './TeammateStage';

describe('TeammateStage', () => {
  let computedStyleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    computedStyleSpy = vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      display: 'block',
      visibility: 'visible',
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration);
  });

  afterEach(() => {
    computedStyleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('falls back cleanly while keeping the private avatar local when WebGL is unavailable', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);

    const { container } = render(
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, cssVar: false }}>
        <TeammateStage name="Research teammate" imageUrl="blob:private-profile-image" emoji="🔎" />
      </ConfigProvider>
    );

    expect(await screen.findByText(/Interactive 3D is unavailable in this browser/i)).toBeVisible();
    expect(screen.getByAltText('Research teammate profile')).toHaveAttribute(
      'src',
      'blob:private-profile-image'
    );
    expect(screen.getByText('Local rendering')).toBeVisible();
    expect(screen.getByRole('button', { name: /Pause rotation/i })).toBeDisabled();
    expect(container.querySelector('canvas')).toHaveAttribute(
      'aria-label',
      'Interactive 3D stage preview for Research teammate'
    );
  });
});
