import { render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, describe, expect, it } from 'vitest';
import { TeammateStage } from './TeammateStage';

afterEach(() => {
  document.body.replaceChildren();
});

describe('TeammateStage layout (real browser)', () => {
  it('renders a bounded stage and usable controls at every supported viewport', async () => {
    render(
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
        <App>
          <TeammateStage name="Research teammate" emoji="🔎" />
        </App>
      </ConfigProvider>
    );

    const surface = await screen.findByTestId('teammate-stage-surface');
    await waitFor(() => expect(screen.getByText('No generated 3D model yet')).toBeVisible());

    const surfaceRect = surface.getBoundingClientRect();
    expect(surfaceRect.width).toBeGreaterThan(200);
    expect(surfaceRect.right).toBeLessThanOrEqual(window.innerWidth + 1);
    expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth + 1);
    expect(screen.getByRole('button', { name: /Reset view/i })).toBeVisible();
    expect(screen.getByText('Private Agor model')).toBeVisible();
  });
});
