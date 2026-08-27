import type { AgorClient, Artifact, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { runArtifactScheduleAction } from '../../utils/artifactActions';
import { HomePinnedArtifactsSection } from './HomePinnedArtifactsSection';

vi.mock('../../utils/artifactActions', () => ({
  runArtifactScheduleAction: vi.fn(),
}));

vi.mock('../../utils/message', () => ({
  useThemedMessage: () => ({ showError: vi.fn(), showSuccess: vi.fn() }),
}));

const artifact = {
  artifact_id: 'artifact-1',
  board_id: 'board-1',
  name: 'Release console',
  description: 'Small, reusable release actions.',
  agor_runtime: {
    interactions: {
      actions: [
        {
          action_id: 'review',
          label: 'Run review',
          schedule_id: 'schedule-1',
        },
      ],
      chat_session_id: 'session-1',
    },
  },
} as unknown as Artifact;

const user = {
  user_id: 'user-1',
  preferences: { home_artifact_ids: [artifact.artifact_id] },
} as unknown as User;

describe('HomePinnedArtifactsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agorStore.setState({
      ...EMPTY_MAPS,
      userById: new Map([[user.user_id, user]]),
      artifactById: new Map([[artifact.artifact_id, artifact]]),
    });
  });

  it('renders declared actions and canonical chat/board controls', () => {
    vi.mocked(runArtifactScheduleAction).mockResolvedValue({ session_id: 'new-session' });
    const onBoardClick = vi.fn();
    const onSessionClick = vi.fn();
    render(
      <ConfigProvider wave={{ disabled: true }}>
        <AntApp>
          <HomePinnedArtifactsSection
            client={null}
            currentUserId={user.user_id}
            onBoardClick={onBoardClick}
            onSessionClick={onSessionClick}
          />
        </AntApp>
      </ConfigProvider>
    );

    expect(screen.getByText('Run review')).toBeInTheDocument();
    expect(screen.getByText('Open chat')).toBeInTheDocument();
    expect(screen.getByText('Show board')).toBeInTheDocument();
  });

  it('unpins while preserving the rest of the preference object', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    render(
      <ConfigProvider wave={{ disabled: true }}>
        <AntApp>
          <HomePinnedArtifactsSection
            client={client}
            currentUserId={user.user_id}
            onBoardClick={vi.fn()}
            onSessionClick={vi.fn()}
          />
        </AntApp>
      </ConfigProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Release console from Home' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(user.user_id, {
        preferences: { home_artifact_ids: [] },
      })
    );
  });
});
