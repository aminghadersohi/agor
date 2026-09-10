import type { AgorClient, PowerManagementStatus, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { Button, Tag, Tooltip } from 'antd';
import { usePowerManagementStatus } from '../hooks/usePowerManagementStatus';
import { useSettingsRoute } from '../hooks/useSettingsRoute';

export interface PowerPresentation {
  label: string;
  shortLabel: string;
  color: 'default' | 'error' | 'processing' | 'success' | 'warning';
  detected: boolean;
}

/** Present provider facts independently from the Agor admission-policy mode. */
export function powerSourcePresentation(
  status: PowerManagementStatus | null,
  error: boolean
): PowerPresentation {
  if (error) {
    return {
      label: 'Provider unavailable',
      shortLabel: 'Unavailable',
      color: 'error',
      detected: false,
    };
  }
  if (!status) {
    return {
      label: 'Reading provider',
      shortLabel: 'Loading',
      color: 'default',
      detected: false,
    };
  }
  if (status.provider_supported === false) {
    return {
      label: 'Unsupported topology',
      shortLabel: 'Unsupported',
      color: 'error',
      detected: false,
    };
  }
  if (status.freshness === 'stale') {
    return { label: 'Provider stale', shortLabel: 'Stale', color: 'error', detected: false };
  }
  const observation = status.observation;
  if (!observation && status.mode === 'off' && status.provider_supported === undefined) {
    return {
      label: 'Not monitored by this daemon',
      shortLabel: 'Not monitored',
      color: 'default',
      detected: false,
    };
  }
  if (
    status.freshness !== 'fresh' ||
    !observation ||
    observation.communication === 'lost' ||
    observation.condition === 'unknown'
  ) {
    return {
      label: 'Provider unavailable',
      shortLabel: 'Unavailable',
      color: 'error',
      detected: false,
    };
  }
  if (observation.condition === 'battery') {
    if (status.state === 'critical') {
      return {
        label: 'Battery power (critical)',
        shortLabel: 'Battery critical',
        color: 'error',
        detected: true,
      };
    }
    return { label: 'Battery power', shortLabel: 'Battery', color: 'warning', detected: true };
  }
  return { label: 'Utility power', shortLabel: 'Utility', color: 'success', detected: true };
}

export function powerPolicyLabel(
  status: PowerManagementStatus | null
): 'Off' | 'Observe' | 'Enforce' | 'Unknown' {
  if (!status) return 'Unknown';
  if (status?.mode === 'observe') return 'Observe';
  if (status?.mode === 'enforce') return 'Enforce';
  return 'Off';
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
  const source = powerSourcePresentation(status, error);
  const policy = powerPolicyLabel(status);
  // Keep the header chip compact on phone widths; the accessible name and
  // tooltip spell out which value is the source and which is the policy.
  const ownershipLost = status?.ownership === 'lost';
  const visibleLabel = ownershipLost
    ? `Admission blocked · ${policy}`
    : `${source.shortLabel} · ${policy}`;
  const accessibleLabel = `Power source: ${source.label}. Power conservation: ${policy}.${ownershipLost ? ' Host ownership lost; new admissions blocked.' : ''}`;
  return (
    <Tooltip title={`${accessibleLabel} Open power configuration and monitoring.`}>
      <Button
        type="text"
        size="small"
        aria-label={accessibleLabel}
        onClick={() => (onOpen ? onOpen() : openSettings('power'))}
      >
        <Tag color={ownershipLost ? 'error' : source.color} style={{ marginInlineEnd: 0 }}>
          {visibleLabel}
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
