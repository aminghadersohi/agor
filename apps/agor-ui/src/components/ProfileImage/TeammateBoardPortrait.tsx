import type { Branch } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { theme } from 'antd';
import { useMemo } from 'react';
import { TeammateIdentityAvatar } from '../TeammateIdentityAvatar';
import { ProfileImagePreview } from './ProfileImagePreview';
import { useProfileImageGallery } from './useProfileImageGallery';

interface TeammateBoardPortraitProps {
  branch: Branch;
  primarySize?: number;
  alternativeSize?: number;
  maxAlternatives?: number;
}

/** Large board portrait with a compact, non-circular glimpse of gallery alternatives. */
export function TeammateBoardPortrait({
  branch,
  primarySize = 56,
  alternativeSize = 22,
  maxAlternatives = 3,
}: TeammateBoardPortraitProps) {
  const { token } = theme.useToken();
  const config = getTeammateConfig(branch);
  const images = useProfileImageGallery({ type: 'teammate', id: branch.branch_id });
  const alternatives = useMemo(
    () =>
      images
        .filter((image) => image.image_id !== config?.profileImageId && !image.is_primary)
        .slice(0, maxAlternatives),
    [config?.profileImageId, images, maxAlternatives]
  );

  return (
    <div
      data-testid="teammate-board-portrait"
      style={{
        position: 'relative',
        width: alternatives.length > 0 ? primarySize + alternativeSize * 0.7 : primarySize,
        height: primarySize,
        flexShrink: 0,
      }}
    >
      <TeammateIdentityAvatar
        branch={branch}
        size={primarySize}
        shape="square"
        style={{ borderRadius: token.borderRadiusLG, boxShadow: token.boxShadowTertiary }}
      />
      {alternatives.length > 0 && (
        <div
          title={`${alternatives.length} alternate teammate photo${alternatives.length === 1 ? '' : 's'}`}
          style={{
            position: 'absolute',
            insetInlineStart: primarySize - alternativeSize * 0.55,
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
              size={alternativeSize}
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
