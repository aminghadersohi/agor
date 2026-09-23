import { fireEvent, render, screen } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeammateStage } from './TeammateStage';

describe('TeammateStage', () => {
  beforeEach(() => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      display: 'block',
      visibility: 'visible',
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration);
  });

  afterEach(() => vi.restoreAllMocks());

  it('shows the real source photo and requires confirmation before provider generation', async () => {
    const onGenerate = vi.fn(async () => undefined);
    render(
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, cssVar: false }}>
        <App>
          <TeammateStage
            name="Research teammate"
            imageUrl="blob:private-profile-image"
            emoji="🔎"
            onGenerate={onGenerate}
          />
        </App>
      </ConfigProvider>
    );

    expect(screen.getByAltText('Research teammate source profile')).toHaveAttribute(
      'src',
      'blob:private-profile-image'
    );
    expect(screen.getByText('No generated 3D model yet')).toBeVisible();
    expect(screen.getByText(/Nothing is uploaded until you confirm/i)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /Generate 3D model/ }));
    expect(
      (await screen.findAllByText('Generate a real 3D identity model?')).length
    ).toBeGreaterThan(0);
    expect(onGenerate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Send photo and generate' }));
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it('shows provider progress without pretending an image projection is a model', () => {
    render(
      <ConfigProvider>
        <App>
          <TeammateStage
            name="Research teammate"
            imageUrl="blob:private-profile-image"
            identityModel={{
              provider: 'meshy',
              status: 'in_progress',
              progress: 47,
              model_available: false,
              created_at: '2026-08-26T00:00:00.000Z',
              updated_at: '2026-08-26T00:01:00.000Z',
            }}
            onGenerate={vi.fn()}
          />
        </App>
      </ConfigProvider>
    );

    expect(screen.getByText('Building a textured GLB from the selected photo')).toBeVisible();
    expect(screen.getByRole('button', { name: /Generate 3D model/ })).toBeDisabled();
    expect(screen.queryByText(/Interactive 3D is unavailable/i)).not.toBeInTheDocument();
  });
});
