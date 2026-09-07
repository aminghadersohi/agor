import type { User } from '@agor-live/client';
import { UnorderedListOutlined } from '@ant-design/icons';
import { Button, Flex, Layout, Space, Typography, theme } from 'antd';
import { createContext, type ReactNode, useContext } from 'react';
import { BrandMark } from '../BrandMark';
import { UserIdentityAvatar } from '../UserIdentityAvatar';

// Shared header accessory owned by MobileApp, across home/board/session/comments routes.
export const MobileHeaderAccessory = createContext<ReactNode>(null);

const { Header } = Layout;
const { Title } = Typography;

interface MobileHeaderProps {
  showMenu?: boolean;
  showLogo?: boolean;
  title?: string;
  user?: User | null;
  onMenuClick?: () => void;
  onLogout?: () => void;
}

export const MobileHeader: React.FC<MobileHeaderProps> = ({
  showMenu = true,
  showLogo = false,
  title,
  user,
  onMenuClick,
  onLogout,
}) => {
  const { token } = theme.useToken();
  const accessory = useContext(MobileHeaderAccessory);

  return (
    <Header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Flex gap={8} align="center" style={{ flex: 1, minWidth: 0 }}>
        {showLogo && <BrandMark size={32} />}

        <Title
          level={5}
          ellipsis={{ tooltip: title || 'agor' }}
          style={{
            minWidth: 0,
            margin: 0,
            marginTop: -4,
            color: token.colorText,
            fontSize: showLogo ? 18 : 16,
            fontWeight: showLogo ? 400 : 500,
          }}
        >
          {title || 'agor'}
        </Title>
      </Flex>

      <Space size={12} align="center" style={{ flexShrink: 0 }}>
        {accessory}
        {user && <UserIdentityAvatar user={user} size={28} fontSize="20px" />}

        {showMenu && (
          <Button
            type="text"
            aria-label="Open navigation"
            icon={<UnorderedListOutlined style={{ fontSize: token.fontSizeLG }} />}
            onClick={onMenuClick}
          />
        )}
      </Space>
    </Header>
  );
};
