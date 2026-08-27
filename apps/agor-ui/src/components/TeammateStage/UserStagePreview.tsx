import type { User } from '@agor-live/client';
import { Button, Flex, Typography, theme } from 'antd';
import { useState } from 'react';
import {
  useProfileIdentityModel,
  useProfileImageGallery,
  useProfileImageUrl,
} from '../ProfileImage';
import { getUserInitials } from '../UserIdentityAvatar';
import { TeammateStage } from './TeammateStage';

interface UserStagePreviewProps {
  user: User;
}

export function UserStagePreview({ user }: UserStagePreviewProps) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const gallery = useProfileImageGallery({ type: 'user', id: user.user_id }, open);
  const sourceImage =
    gallery.find((image) => image.image_id === user.profile_image_id) ??
    gallery.find((image) => image.is_primary) ??
    gallery[0];
  const imageUrl = useProfileImageUrl(sourceImage?.image_id, 'large');
  const identity = useProfileIdentityModel(sourceImage, open);
  const name = user.name || user.email || 'User';

  return (
    <Flex vertical gap={token.marginSM}>
      <Flex align="center" justify="space-between" gap={token.marginSM} wrap>
        <div>
          <Typography.Text strong>3D identity stage</Typography.Text>
          <Typography.Text type="secondary" style={{ display: 'block' }}>
            Generate and preview a textured identity model with interactive stage lighting.
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
          modelUrl={identity.modelUrl}
          identityModel={identity.identityModel}
          emoji={getUserInitials(user)}
          active={open}
          generating={identity.generating}
          generationError={identity.error}
          onGenerate={sourceImage ? identity.generate : undefined}
        />
      )}
    </Flex>
  );
}
