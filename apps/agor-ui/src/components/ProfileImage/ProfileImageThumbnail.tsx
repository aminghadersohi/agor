import type { ProfileImage } from '@agor-live/client';
import { StarFilled, StarOutlined } from '@ant-design/icons';
import { Button, Checkbox, Skeleton, Tag, Tooltip, theme } from 'antd';
import type { DragEvent } from 'react';
import { useProfileImageUrl } from './useProfileImageUrl';

/** MIME type that marks an in-gallery reorder drag, as opposed to files dragged in. */
export const PROFILE_IMAGE_REORDER_MIME = 'application/x-agor-profile-image';

interface ProfileImageThumbnailProps {
  image: ProfileImage;
  canEdit: boolean;
  selected: boolean;
  /** Shown faded because an active theme excludes it from every surface. */
  dimmed: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onMakePrimary: () => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}

/** One square gallery tile: preview, selection, main-photo marker, and theme label. */
export function ProfileImageThumbnail({
  image,
  canEdit,
  selected,
  dimmed,
  dragging,
  dropTarget,
  onOpen,
  onToggleSelect,
  onMakePrimary,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: ProfileImageThumbnailProps) {
  const { token } = theme.useToken();
  const url = useProfileImageUrl(image.image_id, 'small');
  const name = image.alt_text || image.original_name;
  const border = selected
    ? token.colorPrimary
    : image.is_primary
      ? token.colorWarning
      : token.colorBorderSecondary;

  return (
    <div
      data-testid="profile-image-thumbnail"
      data-image-id={image.image_id}
      draggable={canEdit}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{
        position: 'relative',
        aspectRatio: '1',
        minWidth: 0,
        overflow: 'hidden',
        borderRadius: token.borderRadiusLG,
        border: `2px solid ${border}`,
        background: token.colorFillTertiary,
        opacity: dragging ? 0.4 : dimmed ? 0.45 : 1,
        boxShadow: dropTarget ? `-4px 0 0 0 ${token.colorPrimary}` : undefined,
        cursor: canEdit ? 'grab' : 'default',
        transition: `opacity ${token.motionDurationMid}`,
      }}
    >
      <button
        type="button"
        aria-label={`Open ${name}`}
        onClick={onOpen}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          padding: 0,
          border: 0,
          background: 'transparent',
          cursor: 'pointer',
        }}
      >
        {url ? (
          <img
            src={url}
            alt={name}
            draggable={false}
            style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Skeleton.Node active style={{ width: '100%', height: '100%' }}>
            {' '}
          </Skeleton.Node>
        )}
      </button>

      {canEdit && (
        <Checkbox
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select ${image.original_name}`}
          style={{
            position: 'absolute',
            insetBlockStart: token.marginXXS,
            insetInlineStart: token.marginXXS,
            padding: token.paddingXXS,
            borderRadius: token.borderRadiusSM,
            background: token.colorBgContainer,
          }}
        />
      )}

      {image.is_primary ? (
        <Tooltip title="Main photo">
          <StarFilled
            aria-hidden
            style={{
              position: 'absolute',
              insetBlockStart: token.marginXXS,
              insetInlineEnd: token.marginXXS,
              padding: token.paddingXXS,
              borderRadius: token.borderRadiusSM,
              background: token.colorBgContainer,
              color: token.colorWarning,
            }}
          />
        </Tooltip>
      ) : (
        canEdit && (
          <Tooltip title="Set as main photo">
            <Button
              size="small"
              type="text"
              aria-label={`Set ${image.original_name} as main photo`}
              icon={<StarOutlined />}
              onClick={onMakePrimary}
              style={{
                position: 'absolute',
                insetBlockStart: token.marginXXS,
                insetInlineEnd: token.marginXXS,
                background: token.colorBgContainer,
              }}
            />
          </Tooltip>
        )
      )}

      {(image.is_primary || image.theme) && (
        <div
          style={{
            position: 'absolute',
            insetInline: token.marginXXS,
            insetBlockEnd: token.marginXXS,
            display: 'flex',
            gap: token.marginXXS,
            minWidth: 0,
            pointerEvents: 'none',
          }}
        >
          {image.is_primary && (
            <Tag color="gold" style={{ marginInlineEnd: 0, flexShrink: 0 }}>
              Main
            </Tag>
          )}
          {image.theme && (
            <Tag
              color="blue"
              title={image.theme}
              style={{
                marginInlineEnd: 0,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {image.theme}
            </Tag>
          )}
        </div>
      )}
    </div>
  );
}
