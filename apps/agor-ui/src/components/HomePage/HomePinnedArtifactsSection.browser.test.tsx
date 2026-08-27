import type { Artifact, User } from '@agor-live/client';
import { cleanup, render, screen } from '@testing-library/react';
import { App, theme as antdTheme, ConfigProvider } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { HomePinnedArtifactsSection } from './HomePinnedArtifactsSection';

afterEach(cleanup);

const artifact = {
  artifact_id: 'artifact-layout',
  board_id: 'board-layout',
  name: 'Operations console with a deliberately long title',
  description: 'Reusable actions and chat navigation for a shared workflow.',
  agor_runtime: {
    interactions: {
      actions: [
        { action_id: 'review', label: 'Run detailed review', schedule_id: 'schedule-review' },
        { action_id: 'summary', label: 'Prepare summary', schedule_id: 'schedule-summary' },
      ],
      chat_session_id: 'session-layout',
    },
  },
} as unknown as Artifact;

const user = {
  user_id: 'user-layout',
  preferences: { home_artifact_ids: [artifact.artifact_id] },
} as unknown as User;

describe('Home pinned artifact responsive layout (real browser)', () => {
  beforeEach(() => {
    agorStore.setState({
      ...EMPTY_MAPS,
      userById: new Map([[user.user_id, user]]),
      artifactById: new Map([[artifact.artifact_id, artifact]]),
    });
  });

  it('keeps actions and navigation usable without horizontal overflow', () => {
    render(
      <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm, token: { motion: false } }}>
        <App>
          <main
            data-testid="home-shell"
            style={{ width: '100%', padding: 12, boxSizing: 'border-box' }}
          >
            <HomePinnedArtifactsSection
              client={null}
              currentUserId={user.user_id}
              onBoardClick={vi.fn()}
              onSessionClick={vi.fn()}
            />
          </main>
        </App>
      </ConfigProvider>
    );

    expect(screen.getByRole('button', { name: /Run detailed review/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Prepare summary/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Open chat/ })).toBeVisible();
    const shell = screen.getByTestId('home-shell');
    expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
  });
});
