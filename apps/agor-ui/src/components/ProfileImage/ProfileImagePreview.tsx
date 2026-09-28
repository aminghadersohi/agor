import type { ProfileImageVariant } from '@agor-live/client';
import { Avatar, type AvatarProps } from 'antd';
import { useProfileImageUrl } from './useProfileImageUrl';

interface ProfileImagePreviewProps extends Omit<AvatarProps, 'src'> {
  imageId?: string | null;
  variant?: ProfileImageVariant;
}

export function ProfileImagePreview({
  imageId,
  variant = 'small',
  ...props
}: ProfileImagePreviewProps) {
  const url = useProfileImageUrl(imageId, variant);
  return <Avatar {...props} src={url} />;
}
