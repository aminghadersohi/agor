import type { AgorClient, PowerManagementStatus, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { Button, Tag, Tooltip } from 'antd';
import { usePowerManagementStatus } from '../hooks/usePowerManagementStatus';
import { useSettingsRoute } from '../hooks/useSettingsRoute';

export function powerStatusLabel(status: PowerManagementStatus | null, error: boolean) {
  if (error) return { label: 'ERROR', color: 'error' };
  if (!status) return { label: 'LOADING', color: 'default' };
  if (status.mode === 'off') return { label: 'OFF', color: 'default' };
  if (status.freshness !== 'fresh' || status.observation?.communication === 'lost') {
    return { label: status.state === 'critical' ? 'CRITICAL · ERROR' : 'ERROR', color: 'error' };
  }
  if (status.reason === 'on_battery_debounce')
    return { label: 'BATTERY · CHECKING', color: 'warning' };
  if (status.recovery_pacing) return { label: 'RECOVERY', color: 'processing' };
  return {
    disabled: { label: 'OFF', color: 'default' },
    unknown: { label: 'ERROR', color: 'error' },
    normal: { label: 'ONLINE', color: 'success' },
    conserve: { label: 'CONSERVE', color: 'warning' },
    critical: { label: 'CRITICAL', color: 'error' },
    recovering: { label: 'RECOVERY', color: 'processing' },
  }[status.state];
}

function AdminIndicator({
  client,
  user,
  onOpen,
}: {
  client: AgorClient;
  user: User;
  onOpen?: () => void;
}) {
  const { status, error } = usePowerManagementStatus(client, `${user.user_id}:${user.role}`);
  const { openSettings } = useSettingsRoute();
  const presentation = powerStatusLabel(status, error);
  const label = `UPS ${presentation.label}${status?.mode === 'observe' ? ' · Observe' : ''}`;
  return (
    <Tooltip
      title={`${label}. ${error ? 'Status cannot be refreshed.' : (status?.reason.replaceAll('_', ' ') ?? 'Reading status.')} Open UPS configuration and monitoring.`}
    >
      <Button
        type="text"
        size="small"
        aria-label={label}
        onClick={() => (onOpen ? onOpen() : openSettings('power'))}
      >
        <Tag color={presentation.color} style={{ marginInlineEnd: 0 }}>
          {label}
        </Tag>
      </Button>
    </Tooltip>
  );
}

export function PowerStatusIndicator({
  client,
  user,
  onOpen,
}: {
  client: AgorClient | null;
  user?: User | null;
  onOpen?: () => void;
}) {
  if (!client || !user || !hasMinimumRole(user.role, ROLES.ADMIN)) return null;
  return (
    <AdminIndicator
      key={`${user.user_id}:${user.role}`}
      client={client}
      user={user}
      onOpen={onOpen}
    />
  );
}
