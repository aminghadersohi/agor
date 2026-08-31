import { Badge, Tooltip, theme } from 'antd';
import type React from 'react';

const RUNNING_COUNT_SLOT_WIDTH = 36;

export function runningSessionCountLabel(count: number): string {
  return `${count} running ${count === 1 ? 'session' : 'sessions'}`;
}

export interface RunningSessionCountProps {
  count: number;
}

/**
 * Compact, non-animated running-Session indicator shared by board-list rows.
 * The fixed-width slot remains present at zero so neighboring names and icons
 * never move when a Session starts or stops; only the badge itself is hidden.
 */
export const RunningSessionCount: React.FC<RunningSessionCountProps> = ({ count }) => {
  const { token } = theme.useToken();
  const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const label = runningSessionCountLabel(normalizedCount);

  return (
    <span
      data-running-session-count-slot
      style={{
        width: RUNNING_COUNT_SLOT_WIDTH,
        minWidth: RUNNING_COUNT_SLOT_WIDTH,
        display: 'inline-flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        flexShrink: 0,
      }}
    >
      {normalizedCount > 0 && (
        <Tooltip title={label}>
          <span role="img" aria-label={label} data-running-session-count>
            <Badge
              count={normalizedCount}
              overflowCount={99}
              title={label}
              styles={{
                indicator: {
                  backgroundColor: token.colorSuccess,
                  boxShadow: 'none',
                },
              }}
            />
          </span>
        </Tooltip>
      )}
    </span>
  );
};
