import type {
  ArtifactActionEffect,
  ArtifactDataSource,
  ArtifactInteractionConfig,
} from '@agor-live/client';
import { shortId } from '@agor-live/client';
import { Empty, Flex, Space, Tag, Typography, theme } from 'antd';

interface BindingRow {
  family: 'Action' | 'Data' | 'Chat';
  id: string;
  label: string;
  description?: string;
  kind: string;
  target: string;
  confirm?: boolean;
}

function describeActionTarget(effect: ArtifactActionEffect): string {
  if (effect.kind === 'schedule_run') return `Run schedule ${shortId(effect.schedule_id)}`;
  return `${effect.enabled ? 'Enable' : 'Disable'} schedule ${shortId(effect.schedule_id)}`;
}

function describeDataTarget(source: ArtifactDataSource): string {
  if (source.kind === 'schedule_status') return `Schedule ${shortId(source.schedule_id)}`;
  return `Session ${shortId(source.session_id)}`;
}

function bindingRows(config: ArtifactInteractionConfig | undefined): BindingRow[] {
  return [
    ...(config?.actions ?? []).map((action) => ({
      family: 'Action' as const,
      id: action.id,
      label: action.label,
      description: action.description,
      kind: action.effect.kind,
      target: describeActionTarget(action.effect),
      confirm: action.confirm === true,
    })),
    ...(config?.data ?? []).map((binding) => ({
      family: 'Data' as const,
      id: binding.id,
      label: binding.label,
      description: binding.description,
      kind: binding.source.kind,
      target: describeDataTarget(binding.source),
    })),
    ...(config?.chats ?? []).map((chat) => ({
      family: 'Chat' as const,
      id: chat.id,
      label: chat.label,
      description: chat.description,
      kind: 'open_chat',
      target: `Session ${shortId(chat.session_id)}`,
    })),
  ];
}

/**
 * Read-only list of what an artifact's declared bindings do, so a person can
 * see each binding's effect and target without reading the artifact's code.
 * Bindings are authored through `agor_artifacts_publish` / `_update`.
 */
export function ArtifactBindingsList({ config }: { config?: ArtifactInteractionConfig }) {
  const { token } = theme.useToken();
  const rows = bindingRows(config);
  if (rows.length === 0) {
    return (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No interaction bindings declared" />
    );
  }
  return (
    <Flex
      vertical
      component="ul"
      gap={token.marginXS}
      aria-label="Interaction bindings"
      style={{ listStyle: 'none', margin: 0, padding: 0 }}
    >
      {rows.map((row) => (
        <li
          key={`${row.family}-${row.id}`}
          style={{
            padding: token.paddingXS,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadiusSM,
          }}
        >
          <Space size={token.marginXXS} wrap>
            <Tag style={{ marginInlineEnd: 0 }}>{row.family}</Tag>
            <Typography.Text strong>{row.label}</Typography.Text>
            <Typography.Text code>{row.id}</Typography.Text>
            {row.confirm && (
              <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                Confirms first
              </Tag>
            )}
          </Space>
          <Typography.Text
            type="secondary"
            style={{ display: 'block', fontSize: token.fontSizeSM }}
          >
            {row.kind} · {row.target}
          </Typography.Text>
          {row.description && (
            <Typography.Text
              type="secondary"
              style={{ display: 'block', fontSize: token.fontSizeSM }}
            >
              {row.description}
            </Typography.Text>
          )}
        </li>
      ))}
    </Flex>
  );
}
