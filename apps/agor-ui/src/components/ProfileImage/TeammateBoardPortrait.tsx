import type { Branch } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { theme } from 'antd';
import { useMemo } from 'react';
import { TeammateIdentityAvatar } from '../TeammateIdentityAvatar';
import { ProfileImagePreview } from './ProfileImagePreview';
import { useProfileImageGallery } from './useProfileImageGallery';

interface TeammateBoardPortraitProps {
  branch: Branch;
}

/** Large board portrait with a compact, non-circular glimpse of gallery alternatives. */
export function TeammateBoardPortrait({ branch }: TeammateBoardPortraitProps) {
  const { token } = theme.useToken();
  const config = getTeammateConfig(branch);
  const images = useProfileImageGallery({ type: 'teammate', id: branch.branch_id });
  const alternatives = useMemo(
    () =>
      images
        .filter((image) => image.image_id !== config?.profileImageId && !image.is_primary)
        .slice(0, 3),
    [config?.profileImageId, images]
  );

  return (
    <div
      data-testid="teammate-board-portrait"
      style={{
        position: 'relative',
        width: alternatives.length > 0 ? 72 : 56,
        height: 56,
        flexShrink: 0,
      }}
    >
      <TeammateIdentityAvatar
        branch={branch}
        size={56}
        shape="square"
        style={{ borderRadius: token.borderRadiusLG, boxShadow: token.boxShadowTertiary }}
      />
      {alternatives.length > 0 && (
        <div
          title={`${alternatives.length} alternate teammate photo${alternatives.length === 1 ? '' : 's'}`}
          style={{
            position: 'absolute',
            insetInlineStart: 44,
            insetBlockEnd: -2,
            display: 'flex',
            flexDirection: 'column-reverse',
            gap: 2,
          }}
        >
          {alternatives.map((image, index) => (
            <ProfileImagePreview
              key={image.image_id}
              imageId={image.image_id}
              variant="small"
              shape="square"
              size={22}
              alt={image.alt_text || image.original_name}
              style={{
                borderRadius: index % 2 === 0 ? token.borderRadiusSM : 2,
                border: `2px solid ${token.colorBgContainer}`,
                boxShadow: token.boxShadowTertiary,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
