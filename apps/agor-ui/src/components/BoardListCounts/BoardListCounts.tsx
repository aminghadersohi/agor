import type { BoardListCounts as BoardListCountValues } from '@agor-live/client';
import { BranchesOutlined, MessageOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Flex, Tooltip, theme } from 'antd';
import type React from 'react';

export type BoardListCountKind = 'worktrees' | 'totalSessions' | 'activeSessions';

export function boardListCountLabel(kind: BoardListCountKind, count: number): string {
  switch (kind) {
    case 'worktrees':
      return `${count} ${count === 1 ? 'worktree' : 'worktrees'}`;
    case 'totalSessions':
      return `${count} total ${count === 1 ? 'session' : 'sessions'}`;
    case 'activeSessions':
      return `${count} active ${count === 1 ? 'session' : 'sessions'}`;
  }
}

function normalizeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export interface BoardListCountsProps {
  counts: BoardListCountValues;
  /** Allow the three compact metrics to wrap on constrained non-menu surfaces. */
  wrap?: boolean;
}

/**
 * The shared, explicitly-labelled Board list projection used by desktop,
 * mobile, Home, navigation, and Settings surfaces.
 */
export const BoardListCounts: React.FC<BoardListCountsProps> = ({ counts, wrap = false }) => {
  const { token } = theme.useToken();
  const values = [
    {
      kind: 'worktrees' as const,
      count: normalizeCount(counts.worktree_count),
      icon: <BranchesOutlined aria-hidden />,
      color: token.colorTextSecondary,
    },
    {
      kind: 'totalSessions' as const,
      count: normalizeCount(counts.total_session_count),
      icon: <MessageOutlined aria-hidden />,
      color: token.colorTextSecondary,
    },
    {
      kind: 'activeSessions' as const,
      count: normalizeCount(counts.active_session_count),
      icon: <ThunderboltOutlined aria-hidden />,
      color: token.colorSuccess,
    },
  ];

  return (
    <Flex
      data-board-list-counts
      align="center"
      gap={token.marginSM}
      wrap={wrap ? 'wrap' : false}
      style={{ minWidth: 0 }}
    >
      {values.map(({ kind, count, icon, color }) => {
        const label = boardListCountLabel(kind, count);
        return (
          <Tooltip key={kind} title={label}>
            <span
              role="img"
              aria-label={label}
              data-board-list-count={kind}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: token.sizeXXS,
                flexShrink: 0,
                color,
                fontSize: token.fontSizeSM,
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {icon}
              <span aria-hidden>{count}</span>
            </span>
          </Tooltip>
        );
      })}
    </Flex>
  );
};
