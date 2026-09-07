import type {
  AgorClient,
  SessionID,
  SessionPowerPriority,
  SessionPowerPriorityView,
} from '@agor-live/client';
import { Alert, Select, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useThemedMessage } from '../../utils/message';

export function SessionPowerPriorityControl({
  client,
  sessionId,
}: {
  client: AgorClient;
  sessionId: SessionID;
}) {
  const { showError, showSuccess } = useThemedMessage();
  const [view, setView] = useState<SessionPowerPriorityView | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const priorityService = client.service(`sessions/${sessionId}/power-priority`);
    const sessionsService = client.service('sessions');
    const load = () =>
      priorityService
        .find()
        .then((result) => {
          if (!cancelled) setView(result);
        })
        .catch(() => {
          if (!cancelled) setView(null);
        });
    void load();
    const refreshForSession = (session: { session_id?: string }) => {
      if (session.session_id === sessionId) void load();
    };
    sessionsService.on('patched', refreshForSession);
    return () => {
      cancelled = true;
      sessionsService.off('patched', refreshForSession);
    };
  }, [client, sessionId]);

  const changePriority = async (priority: SessionPowerPriority) => {
    setSaving(true);
    try {
      const updated = await client
        .service(`sessions/${sessionId}/power-priority`)
        .create({ priority });
      setView(updated);
      showSuccess(
        priority === 'essential'
          ? 'Essential power priority enabled'
          : 'Power priority set to normal'
      );
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to change power priority');
    } finally {
      setSaving(false);
    }
  };

  if (!view)
    return <Typography.Text type="secondary">Power priority is unavailable.</Typography.Text>;
  return (
    <Space orientation="vertical" size="small" style={{ width: '100%' }}>
      <Space wrap>
        <Typography.Text>Requested</Typography.Text>
        <Select
          aria-label="Power priority"
          value={view.requested}
          disabled={!view.can_manage || saving}
          loading={saving}
          onChange={changePriority}
          options={[
            { value: 'normal', label: 'Normal' },
            { value: 'essential', label: 'Essential — keep dispatching on UPS' },
          ]}
          style={{ width: '100%', maxWidth: 360 }}
        />
        <Tag color={view.effective ? 'green' : 'default'}>
          Effective: {view.effective ? 'Essential' : 'Normal'}
        </Tag>
      </Space>
      <Typography.Text type="secondary">
        At most {view.max_essential_sessions} Session is effective as Essential. Branch Manager
        access is required. In conservation, ordinary queued work is held but running work is not
        killed. In Critical, no new turn starts.
      </Typography.Text>
      {!view.can_manage && (
        <Alert
          type="info"
          showIcon
          title="Branch Manager access is required to change this setting."
        />
      )}
    </Space>
  );
}
