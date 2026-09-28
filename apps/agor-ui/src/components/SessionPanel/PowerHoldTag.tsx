import type { AgorClient, SessionPowerPriority } from '@agor-live/client';
import { powerAdmissionHoldsPriority } from '@agor-live/client';
import { ThunderboltOutlined } from '@ant-design/icons';
import { Tooltip } from 'antd';
import { usePowerAdmission } from '../../hooks/usePowerAdmission';
import { Tag } from '../Tag';

export interface PowerHoldTagProps {
  client: AgorClient | null;
  /** Re-reads the projection when the signed-in identity changes. */
  identityKey: string | null;
  powerPriority?: SessionPowerPriority;
  queuedCount: number;
}

/**
 * Inline "held" marker beside the queue count. A power-held prompt otherwise
 * looks exactly like an ordinary queue, so people cancel or re-send it.
 */
export function PowerHoldTag({
  client,
  identityKey,
  powerPriority,
  queuedCount,
}: PowerHoldTagProps) {
  const admission = usePowerAdmission(client, identityKey);
  if (!admission || queuedCount === 0) return null;
  if (!powerAdmissionHoldsPriority(admission, powerPriority)) return null;
  return (
    <Tooltip
      title={`The host power policy is holding new work (${admission.reason.replaceAll('_', ' ')}). Queued prompts stay queued and start automatically after power recovers — no need to re-send them.`}
    >
      <Tag
        color="warning"
        icon={<ThunderboltOutlined />}
        style={{ marginInlineEnd: 0 }}
        data-testid="power-hold-tag"
      >
        Held by host power policy
      </Tag>
    </Tooltip>
  );
}
