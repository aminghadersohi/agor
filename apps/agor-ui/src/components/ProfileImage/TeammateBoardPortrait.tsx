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
  /**
   * Follow the container's width, demoting `primarySize` to an upper bound.
   * Expressed in CSS rather than measured, so dragging a resizable panel
   * resizes the portrait without a React render per pointer frame.
   */
  fill?: boolean;
}

/** Large board portrait with a compact, non-circular glimpse of gallery alternatives. */
export function TeammateBoardPortrait({
  branch,
  primarySize = 56,
  alternativeSize = 22,
  maxAlternatives = 3,
  fill = false,
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

  // The strip straddles the main portrait's trailing edge by 0.55 alternatives,
  // and the root reserves 0.7 beyond that edge for it. Fill mode cannot name
  // the edge in pixels, but `100% - 1.25a` resolves to the same place because
  // the root is 0.7a wider than the portrait.
  const alternativesInset = fill
    ? `calc(100% - ${alternativeSize * 1.25}px)`
    : primarySize - alternativeSize * 0.55;

  return (
    <div
      data-testid="teammate-board-portrait"
      style={{
        position: 'relative',
        width: fill
          ? '100%'
          : alternatives.length > 0
            ? primarySize + alternativeSize * 0.7
            : primarySize,
        // Beyond the server's large variant the portrait is only upscaling, so
        // the fill step stops there and lets the avatar set its own height.
        maxWidth: fill ? primarySize : undefined,
        height: fill ? undefined : primarySize,
        containerType: fill ? 'inline-size' : undefined,
        flexShrink: 0,
      }}
    >
      <TeammateIdentityAvatar
        branch={branch}
        size={primarySize}
        shape="square"
        style={{
          borderRadius: token.borderRadiusLG,
          boxShadow: token.boxShadowTertiary,
          ...(fill
            ? {
                width: alternatives.length > 0 ? `calc(100% - ${alternativeSize * 0.7}px)` : '100%',
                height: 'auto',
                aspectRatio: '1',
                // The emoji/robot fallback has no intrinsic size, so scale it
                // off the container too rather than off the capped `size`.
                fontSize: '50cqi',
              }
            : {}),
        }}
      />
      {alternatives.length > 0 && (
        <div
          title={`${alternatives.length} alternate teammate photo${alternatives.length === 1 ? '' : 's'}`}
          style={{
            position: 'absolute',
            insetInlineStart: alternativesInset,
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
