import type { Board } from '@agor-live/client';
import { DownOutlined } from '@ant-design/icons';
import { Collapse, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import { BoardTile } from '../BoardTile';

const { Text } = Typography;

export interface BoardCollapseItem {
  key: string;
  board: Board;
  /** Pre-resolved board emoji (see {@link getBoardEmoji}). */
  emoji?: string;
  avatarSize?: number;
  meta?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}

interface BoardCollapseProps {
  items: BoardCollapseItem[];
  defaultActiveKey?: string[];
  destroyOnHidden?: boolean;
}

/**
 * Reusable Board-level collapse component with panel styling
 * Matches CommentsPanel aesthetic with board icon + name in header
 */
export const BoardCollapse: React.FC<BoardCollapseProps> = ({
  items,
  defaultActiveKey,
  destroyOnHidden,
}) => {
  const { token } = theme.useToken();

  return (
    <Collapse
      defaultActiveKey={defaultActiveKey}
      destroyOnHidden={destroyOnHidden}
      expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
      style={{
        border: 'none',
        backgroundColor: 'transparent',
        width: '100%',
      }}
      items={items.map(({ key, board, emoji, avatarSize = 20, meta, badge, children }) => ({
        key,
        // The header also contains board/comment action buttons. Restrict the
        // collapse affordance to its chevron so those controls are not nested
        // inside another interactive header target.
        collapsible: 'icon',
        label: (
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0 }}
          >
            <BoardTile board={board} emoji={emoji} size={avatarSize} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text strong ellipsis style={{ display: 'block', fontSize: 14 }}>
                {board.name}
              </Text>
              {meta}
            </div>
            {badge}
          </div>
        ),
        style: {
          marginBottom: 0,
          backgroundColor: token.colorBgContainer,
          borderRadius: 0,
          border: `1px solid ${token.colorBorder}`,
        },
        children: (
          <div
            style={{
              backgroundColor: token.colorBgLayout,
              margin: -16,
              padding: 16,
            }}
          >
            {children}
          </div>
        ),
      }))}
    />
  );
};
