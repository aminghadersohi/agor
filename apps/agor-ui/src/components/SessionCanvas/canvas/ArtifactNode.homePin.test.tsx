import type { AgorClient, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../../store/agorMaps';
import { agorStore } from '../../../store/agorStore';
import { ArtifactNode, type ArtifactNodeData } from './ArtifactNode';

vi.mock('reactflow', () => ({ NodeResizer: () => null }));

vi.mock('@codesandbox/sandpack-react', () => ({
  SandpackProvider: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SandpackPreview: () => <div data-testid="sandpack-preview" />,
  useSandpack: () => ({ sandpack: { files: {}, environment: 'react' } }),
}));

vi.mock('@/utils/sandpackCrypto', () => ({ ensureSandpackCryptoSubtle: vi.fn() }));

const connection = {
  connected: true,
  connecting: false,
  authGeneration: 1,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <ConnectionProvider value={connection}>
    <ConfigProvider wave={{ disabled: true }}>
      <AntApp>{children}</AntApp>
    </ConfigProvider>
  </ConnectionProvider>
);

const USER_ID = 'user-fixture';
const ARTIFACT_ID = 'artifact-fixture';

function setUser(preferences: Record<string, unknown>) {
  agorStore.setState({
    ...EMPTY_MAPS,
    userById: new Map([[USER_ID, { user_id: USER_ID, preferences } as unknown as User]]),
  });
}

function renderNode(patch: ReturnType<typeof vi.fn>) {
  const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
  const data: ArtifactNodeData = {
    objectId: 'object-fixture',
    artifactId: ARTIFACT_ID,
    width: 480,
    height: 320,
    canEdit: false,
    x: 0,
    y: 0,
    onUpdate: vi.fn(),
    client,
    currentUserId: USER_ID,
  };
  return render(<ArtifactNode data={data} />, { wrapper });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => undefined))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ArtifactNode Home pin', () => {
  it('pins to Home without board.edit, preserving other preferences', async () => {
    setUser({ theme: 'dark' });
    const patch = vi.fn().mockResolvedValue({});
    renderNode(patch);

    fireEvent.click(screen.getByLabelText('Artifact placement'));
    fireEvent.click(await screen.findByText('Pin to Home'));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(USER_ID, {
        preferences: { theme: 'dark', home_artifact_ids: [ARTIFACT_ID] },
      })
    );
  });

  it('offers removal when the artifact is already pinned', async () => {
    setUser({ home_artifact_ids: ['other-artifact', ARTIFACT_ID] });
    const patch = vi.fn().mockResolvedValue({});
    renderNode(patch);

    fireEvent.click(screen.getByLabelText('Artifact placement'));
    fireEvent.click(await screen.findByText('Remove from Home'));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(USER_ID, {
        preferences: { home_artifact_ids: ['other-artifact'] },
      })
    );
  });
});
