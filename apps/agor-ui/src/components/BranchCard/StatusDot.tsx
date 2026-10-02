// Kept for the collapsed-card session picker after upstream removed Home's StatusDot.
import { Tooltip, theme } from 'antd';
import type React from 'react';
import { getSessionStatusLabel } from '../../utils/sessionStatus';

const STATUS_ANIMATION: Record<string, string> = {
  running: 'status-dot-run',
  awaiting_permission: 'status-dot-wait',
  awaiting_input: 'status-dot-wait',
  stopping: 'status-dot-wait',
};

export const StatusDot: React.FC<{ status: string; size?: number }> = ({ status, size = 7 }) => {
  const { token } = theme.useToken();

  const statusColor = (() => {
    switch (status) {
      case 'running':
        return token.colorSuccess;
      case 'awaiting_permission':
      case 'awaiting_input':
      case 'stopping':
        return token.colorWarning;
      case 'timed_out':
      case 'failed':
        return token.colorError;
      default:
        return token.colorTextQuaternary;
    }
  })();

  const cls = STATUS_ANIMATION[status] ?? '';
  const label = getSessionStatusLabel(status);
  return (
    <Tooltip title={label}>
      <span
        role="img"
        aria-label={`Status: ${label}`}
        className={cls}
        style={{
          display: 'inline-block',
          width: size,
          height: size,
          borderRadius: '50%',
          background: statusColor,
          flexShrink: 0,
        }}
      />
    </Tooltip>
  );
};
