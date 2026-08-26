import type { Branch } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { RobotOutlined } from '@ant-design/icons';
import { Avatar, type AvatarProps, theme } from 'antd';
import { useProfileImageUrl } from './ProfileImage/useProfileImageUrl';

interface TeammateIdentityAvatarProps extends Omit<AvatarProps, 'src'> {
  branch?: Branch | null;
  size?: number;
}

/** Photo-first teammate identity with emoji and robot fallbacks. */
export function TeammateIdentityAvatar({
  branch,
  size = 32,
  ...props
}: TeammateIdentityAvatarProps) {
  const { token } = theme.useToken();
  const config = branch ? getTeammateConfig(branch) : undefined;
  const imageUrl = useProfileImageUrl(config?.profileImageId, size > 96 ? 'large' : 'small');

  return (
    <Avatar
      {...props}
      src={imageUrl}
      size={size}
      shape="circle"
      style={{
        backgroundColor: imageUrl ? token.colorBgContainer : token.colorInfoBg,
        color: token.colorInfo,
        fontSize: Math.round(size * 0.62),
        flexShrink: 0,
        ...props.style,
      }}
    >
      {config?.emoji || <RobotOutlined />}
    </Avatar>
  );
}
