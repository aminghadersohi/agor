import type { AgorClient, Artifact, ArtifactActionBinding, ArtifactID } from '@agor-live/client';
import { artifactFullscreenPath } from '@agor-live/client';
import {
  AppstoreOutlined,
  CommentOutlined,
  FullscreenOutlined,
  PushpinFilled,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { App, Button, Card, Empty, Space, Tag, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectArtifactById } from '../../store/selectors';
import { runArtifactScheduleAction } from '../../utils/artifactActions';
import { readHomeArtifactIds, withHomeArtifactPin } from '../../utils/homeArtifactPreferences';
import { useThemedMessage } from '../../utils/message';
import { uiRouteHref } from '../../utils/uiRoutes';

function PinnedArtifactCard({
  artifact,
  onBoardClick,
  onSessionClick,
  onUnpin,
}: {
  artifact: Artifact;
  onBoardClick: (boardId: string) => void;
  onSessionClick: (sessionId: string) => void;
  onUnpin: (artifactId: ArtifactID) => Promise<void>;
}) {
  const { token } = theme.useToken();
  const { modal } = App.useApp();
  const { showError, showSuccess } = useThemedMessage();
  const [runningActionId, setRunningActionId] = useState<string>();
  const interactions = artifact.agor_runtime?.interactions;
  const actions = interactions?.actions ?? [];

  const runAction = async (action: ArtifactActionBinding) => {
    if (runningActionId) return;
    if (action.confirm) {
      const confirmed = await new Promise<boolean>((resolve) => {
        modal.confirm({
          title: `Run “${action.label}”?`,
          content: action.description || 'This starts a session using the configured action.',
          okText: 'Run action',
          cancelText: 'Cancel',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!confirmed) return;
    }
    setRunningActionId(action.action_id);
    try {
      await runArtifactScheduleAction(action.schedule_id);
      showSuccess(`Started “${action.label}”`);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Could not run action');
    } finally {
      setRunningActionId(undefined);
    }
  };

  return (
    <Card
      size="small"
      title={artifact.name}
      extra={
        <Button
          type="text"
          size="small"
          aria-label={`Remove ${artifact.name} from Home`}
          icon={<PushpinFilled />}
          onClick={() => void onUnpin(artifact.artifact_id)}
        />
      }
      styles={{ body: { minWidth: 0 } }}
    >
      {artifact.description && (
        <Typography.Paragraph
          type="secondary"
          ellipsis={{ rows: 2 }}
          style={{ marginBottom: token.marginSM }}
        >
          {artifact.description}
        </Typography.Paragraph>
      )}
      <Space wrap size={[4, 4]} style={{ marginBottom: token.marginSM }}>
        {actions.length > 0 && <Tag icon={<ThunderboltOutlined />}>{actions.length} actions</Tag>}
        {interactions?.chat_session_id && <Tag icon={<CommentOutlined />}>Chat</Tag>}
      </Space>
      {actions.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))',
            gap: token.marginXS,
            marginBottom: token.marginSM,
          }}
        >
          {actions.map((action) => (
            <Button
              key={action.action_id}
              block
              title={action.description}
              icon={<ThunderboltOutlined />}
              loading={runningActionId === action.action_id}
              disabled={!!runningActionId && runningActionId !== action.action_id}
              onClick={() => void runAction(action)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: token.marginXS, flexWrap: 'wrap' }}>
        {interactions?.chat_session_id && (
          <Button
            size="small"
            type="primary"
            icon={<CommentOutlined />}
            onClick={() => onSessionClick(interactions.chat_session_id!)}
          >
            Open chat
          </Button>
        )}
        <Button
          size="small"
          icon={<FullscreenOutlined />}
          onClick={() =>
            window.open(
              uiRouteHref(artifactFullscreenPath(artifact.artifact_id)),
              '_blank',
              'noopener,noreferrer'
            )
          }
        >
          Open app
        </Button>
        <Button
          size="small"
          type="text"
          icon={<AppstoreOutlined />}
          onClick={() => onBoardClick(artifact.board_id)}
        >
          Show board
        </Button>
      </div>
    </Card>
  );
}

export function HomePinnedArtifactsSection({
  client,
  currentUserId,
  onBoardClick,
  onSessionClick,
}: {
  client: AgorClient | null;
  currentUserId?: string;
  onBoardClick: (boardId: string) => void;
  onSessionClick: (sessionId: string) => void;
}) {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const artifactById = useAgorStore(selectArtifactById);
  const currentUser = useAgorStore((state) =>
    currentUserId ? state.userById.get(currentUserId) : undefined
  );
  const pinnedIds = useMemo(
    () => readHomeArtifactIds(currentUser?.preferences),
    [currentUser?.preferences]
  );
  const artifacts = useMemo(
    () => pinnedIds.flatMap((id) => (artifactById.get(id) ? [artifactById.get(id)!] : [])),
    [artifactById, pinnedIds]
  );
  if (pinnedIds.length === 0) return null;

  const unpin = async (artifactId: ArtifactID) => {
    if (!client || !currentUserId || !currentUser) return;
    try {
      await client.service('users').patch(currentUserId, {
        preferences: withHomeArtifactPin(currentUser.preferences, artifactId, false),
      });
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Could not remove Home pin');
    }
  };

  return (
    <section style={{ marginTop: token.marginLG }} aria-labelledby="home-artifacts-heading">
      <Space align="center" style={{ marginBottom: token.marginSM }}>
        <PushpinFilled style={{ color: token.colorPrimary }} />
        <Typography.Title id="home-artifacts-heading" level={5} style={{ margin: 0 }}>
          Pinned apps
        </Typography.Title>
      </Space>
      {artifacts.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Pinned artifacts are no longer available"
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
            gap: token.marginSM,
          }}
        >
          {artifacts.map((artifact) => (
            <PinnedArtifactCard
              key={artifact.artifact_id}
              artifact={artifact}
              onBoardClick={onBoardClick}
              onSessionClick={onSessionClick}
              onUnpin={unpin}
            />
          ))}
        </div>
      )}
    </section>
  );
}
