import type { ProfileImage } from '@agor-live/client';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  DeleteOutlined,
  LeftOutlined,
  RightOutlined,
  StarFilled,
  StarOutlined,
} from '@ant-design/icons';
import {
  Button,
  Flex,
  Grid,
  Input,
  Modal,
  Popconfirm,
  Skeleton,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useEffect, useState } from 'react';
import { ProfileImageThemeInput } from './ProfileImageThemeControls';
import { useProfileImageUrl } from './useProfileImageUrl';

interface ProfileImageLightboxProps {
  /** Gallery in display order; the lightbox pages through it. */
  images: ProfileImage[];
  /** Image id being shown, or undefined when closed. */
  openImageId: string | undefined;
  canEdit: boolean;
  /** Offer theme labelling (teammate galleries only). */
  showThemes: boolean;
  themes: string[];
  busy: boolean;
  onNavigate: (imageId: string) => void;
  onClose: () => void;
  onMakePrimary: (image: ProfileImage) => void;
  onMove: (image: ProfileImage, offset: -1 | 1) => void;
  onRemove: (image: ProfileImage) => void;
  onUpdate: (image: ProfileImage, patch: { theme?: string | null; alt_text?: string }) => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  );
}

/** Large preview with paging, theme/alt-text editing, ordering, and removal. */
export function ProfileImageLightbox({
  images,
  openImageId,
  canEdit,
  showThemes,
  themes,
  busy,
  onNavigate,
  onClose,
  onMakePrimary,
  onMove,
  onRemove,
  onUpdate,
}: ProfileImageLightboxProps) {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const compact = !screens.md;
  const index = images.findIndex((image) => image.image_id === openImageId);
  const image = index >= 0 ? images[index] : undefined;
  const url = useProfileImageUrl(image?.image_id, 'large');
  const [themeDraft, setThemeDraft] = useState('');
  const [altDraft, setAltDraft] = useState('');

  // Drafts follow the image being shown, not the one that was open before; the
  // id is a dependency so paging between two unlabeled images still resets them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: image_id is the reset trigger
  useEffect(() => {
    setThemeDraft(image?.theme ?? '');
    setAltDraft(image?.alt_text ?? '');
  }, [image?.image_id, image?.theme, image?.alt_text]);

  const previousId = index > 0 ? images[index - 1].image_id : undefined;
  const nextId = index >= 0 && index < images.length - 1 ? images[index + 1].image_id : undefined;

  useEffect(() => {
    if (!image) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === 'ArrowLeft' && previousId) onNavigate(previousId);
      if (event.key === 'ArrowRight' && nextId) onNavigate(nextId);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [image, nextId, onNavigate, previousId]);

  const commitTheme = (value: string) => {
    if (!image) return;
    if ((value.trim() || undefined) === image.theme) return;
    onUpdate(image, { theme: value.trim() || null });
  };
  const commitAlt = () => {
    if (!image) return;
    if ((altDraft.trim() || undefined) === image.alt_text) return;
    onUpdate(image, { alt_text: altDraft.trim() });
  };

  return (
    <Modal
      open={Boolean(image)}
      onCancel={onClose}
      footer={null}
      centered
      destroyOnHidden
      width="min(94vw, 1040px)"
      title={image ? `${image.original_name} (${index + 1} of ${images.length})` : undefined}
    >
      {image && (
        <Flex vertical={compact} gap={token.marginMD} style={{ minWidth: 0 }}>
          <Flex
            align="center"
            justify="center"
            gap={token.marginXS}
            style={{ flex: 1, minWidth: 0 }}
          >
            <Button
              aria-label="Previous photo"
              shape="circle"
              icon={<LeftOutlined />}
              disabled={!previousId}
              onClick={() => previousId && onNavigate(previousId)}
            />
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                justifyContent: 'center',
                background: token.colorFillTertiary,
                borderRadius: token.borderRadiusLG,
                overflow: 'hidden',
              }}
            >
              {url ? (
                <img
                  src={url}
                  alt={image.alt_text || image.original_name}
                  style={{
                    display: 'block',
                    maxWidth: '100%',
                    maxHeight: '68vh',
                    objectFit: 'contain',
                  }}
                />
              ) : (
                <Skeleton.Image active style={{ width: 320, height: 320 }} />
              )}
            </div>
            <Button
              aria-label="Next photo"
              shape="circle"
              icon={<RightOutlined />}
              disabled={!nextId}
              onClick={() => nextId && onNavigate(nextId)}
            />
          </Flex>

          <Flex
            vertical
            gap={token.marginSM}
            style={{ width: compact ? '100%' : 260, flexShrink: 0, minWidth: 0 }}
          >
            <Flex gap={token.marginXS} wrap>
              {image.is_primary && (
                <Tag color="gold" icon={<StarFilled />}>
                  Main photo
                </Tag>
              )}
              {image.theme && <Tag color="blue">{image.theme}</Tag>}
              <Typography.Text type="secondary">
                {image.large_width}×{image.large_height}
              </Typography.Text>
            </Flex>

            {showThemes && (
              <div>
                <Typography.Text strong>Theme</Typography.Text>
                <ProfileImageThemeInput
                  value={themeDraft}
                  onChange={setThemeDraft}
                  themes={themes}
                  ariaLabel="Photo theme"
                  disabled={!canEdit || busy}
                  onCommit={commitTheme}
                  onBlur={() => commitTheme(themeDraft)}
                  style={{ display: 'block', width: '100%' }}
                />
              </div>
            )}

            <div>
              <Typography.Text strong>Description</Typography.Text>
              <Input
                value={altDraft}
                maxLength={240}
                aria-label="Photo description"
                placeholder="Describe the photo for screen readers"
                disabled={!canEdit || busy}
                onChange={(event) => setAltDraft(event.target.value)}
                onBlur={commitAlt}
                onPressEnter={commitAlt}
              />
            </div>

            {canEdit && (
              <Flex vertical gap={token.marginXS}>
                {!image.is_primary && (
                  <Button
                    icon={<StarOutlined />}
                    loading={busy}
                    onClick={() => onMakePrimary(image)}
                  >
                    Set as main photo
                  </Button>
                )}
                <Flex gap={token.marginXS}>
                  <Button
                    icon={<ArrowLeftOutlined />}
                    disabled={!previousId || busy}
                    onClick={() => onMove(image, -1)}
                    style={{ flex: 1 }}
                  >
                    Move earlier
                  </Button>
                  <Button
                    icon={<ArrowRightOutlined />}
                    iconPlacement="end"
                    disabled={!nextId || busy}
                    onClick={() => onMove(image, 1)}
                    style={{ flex: 1 }}
                  >
                    Move later
                  </Button>
                </Flex>
                <Popconfirm
                  title="Remove this photo?"
                  description={
                    image.is_primary ? 'Another photo will become the main photo.' : undefined
                  }
                  okText="Remove"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => onRemove(image)}
                >
                  <Button danger icon={<DeleteOutlined />} loading={busy}>
                    Remove photo
                  </Button>
                </Popconfirm>
              </Flex>
            )}
          </Flex>
        </Flex>
      )}
    </Modal>
  );
}
