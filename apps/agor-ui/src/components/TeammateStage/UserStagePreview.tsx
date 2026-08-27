import type { User } from '@agor-live/client';
import { Button, Flex, Typography, theme } from 'antd';
import { useState } from 'react';
import { useUserProfileImageUrl } from '../ProfileImage';
import { getUserInitials } from '../UserIdentityAvatar';
import { TeammateStage } from './TeammateStage';

interface UserStagePreviewProps {
  user: User;
}

export function UserStagePreview({ user }: UserStagePreviewProps) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const imageUrl = useUserProfileImageUrl(user, 'large');
  const name = user.name || user.email || 'User';

  return (
    <Flex vertical gap={token.marginSM}>
      <Flex align="center" justify="space-between" gap={token.marginSM} wrap>
        <div>
          <Typography.Text strong>3D identity stage</Typography.Text>
          <Typography.Text type="secondary" style={{ display: 'block' }}>
            Preview this profile locally with interactive stage lighting.
          </Typography.Text>
        </div>
        <Button onClick={() => setOpen((current) => !current)}>
          {open ? 'Hide 3D stage' : 'View 3D stage'}
        </Button>
      </Flex>
      {open && (
        <TeammateStage
          name={name}
          imageUrl={imageUrl}
          emoji={getUserInitials(user)}
          active={open}
        />
      )}
    </Flex>
  );
}
