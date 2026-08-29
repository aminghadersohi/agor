import type { ProfileImage, ProfileImageID } from '@agor-live/client';
import {
  CheckCircleFilled,
  DeleteOutlined,
  PictureOutlined,
  StarOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Flex,
  Grid,
  Popconfirm,
  Skeleton,
  Tag,
  Typography,
  theme,
  Upload,
} from 'antd';
import type { RcFile } from 'antd/es/upload/interface';
import { useCallback, useEffect, useState } from 'react';
import { ProfileImagePreview } from './ProfileImagePreview';
import {
  deleteProfileImage,
  listProfileImages,
  type ProfileImageSubject,
  patchProfileImage,
  uploadProfileImage,
} from './profileImageApi';
import { publishProfileImageGallery } from './useProfileImageGallery';

const ACCEPTED_PROFILE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PROFILE_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
/**
 * Placeholder only, shown for the one frame before the list route answers with
 * the authoritative `max_images`. Mirrors the server's cap so the copy does not
 * flash a smaller number, but the server remains the one that enforces it.
 */
const ASSUMED_MAX_GALLERY_IMAGES = 24;

function validateProfileImageFile(file: File): string | undefined {
  if (!ACCEPTED_PROFILE_IMAGE_TYPES.has(file.type)) return 'Use a JPEG, PNG, or WebP image';
  if (file.size === 0) return 'Choose a non-empty image';
  if (file.size > MAX_PROFILE_IMAGE_UPLOAD_BYTES) return 'Images must be 5 MB or smaller';
  return undefined;
}

interface ProfileImageGalleryEditorProps {
  subject: ProfileImageSubject;
  canEdit: boolean;
  label: string;
  onPrimaryChange?: (imageId: ProfileImageID | null) => void;
}

export function ProfileImageGalleryEditor({
  subject,
  canEdit,
  label,
  onPrimaryChange,
}: ProfileImageGalleryEditorProps) {
  const { id: subjectId, type: subjectType } = subject;
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const compact = !screens.sm;
  const { message } = App.useApp();
  const [images, setImages] = useState<ProfileImage[]>([]);
  const [maxImages, setMaxImages] = useState(ASSUMED_MAX_GALLERY_IMAGES);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await listProfileImages({ id: subjectId, type: subjectType });
      setImages(result.images);
      setMaxImages(result.max_images);
      publishProfileImageGallery({ id: subjectId, type: subjectType }, result);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Profile images could not load');
    } finally {
      setLoading(false);
    }
  }, [subjectId, subjectType]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleUploadBatch = async (selectedFiles: RcFile[]) => {
    const availableSlots = Math.max(0, maxImages - images.length);
    const files = selectedFiles.slice(0, availableSlots);
    if (selectedFiles.length > availableSlots) {
      message.warning(
        availableSlots === 0
          ? `This gallery already has ${maxImages} images`
          : `Only the first ${availableSlots} selected image${availableSlots === 1 ? '' : 's'} can fit`
      );
    }

    const validFiles: RcFile[] = [];
    for (const file of files) {
      const validationError = validateProfileImageFile(file);
      if (validationError) message.error(`${file.name}: ${validationError}`);
      else validFiles.push(file);
    }
    if (validFiles.length === 0) return;

    setUploading(true);
    setUploadProgress({ completed: 0, total: validFiles.length });
    let uploaded = 0;
    let failed = 0;
    let createdPrimary: ProfileImageID | undefined;
    try {
      // Keep uploads sequential: the server enforces the gallery cap atomically,
      // and a batch should preserve the order the user selected.
      for (const file of validFiles) {
        try {
          const created = await uploadProfileImage(subject, file);
          uploaded += 1;
          if (created.is_primary) createdPrimary = created.image_id;
        } catch (nextError) {
          failed += 1;
          message.error(
            `${file.name}: ${nextError instanceof Error ? nextError.message : 'Upload failed'}`
          );
        } finally {
          setUploadProgress((current) => ({ ...current, completed: current.completed + 1 }));
        }
      }
      if (uploaded > 0) {
        await refresh();
        if (createdPrimary) onPrimaryChange?.(createdPrimary);
        message.success(`${uploaded} image${uploaded === 1 ? '' : 's'} added`);
      }
      if (failed > 0 && uploaded > 0) {
        message.warning(`${failed} image${failed === 1 ? '' : 's'} could not be uploaded`);
      }
    } finally {
      setUploading(false);
      setUploadProgress({ completed: 0, total: 0 });
    }
  };

  const galleryFull = images.length >= maxImages;

  const queueUploadBatch = (file: RcFile, fileList: RcFile[]) => {
    if (file.uid === fileList[0]?.uid) void handleUploadBatch(fileList);
    return Upload.LIST_IGNORE;
  };

  const makePrimary = async (image: ProfileImage) => {
    setBusyId(image.image_id);
    try {
      await patchProfileImage(image.image_id, { is_primary: true });
      await refresh();
      onPrimaryChange?.(image.image_id);
      message.success('Main image updated');
    } catch (nextError) {
      message.error(nextError instanceof Error ? nextError.message : 'Photo could not be updated');
    } finally {
      setBusyId(undefined);
    }
  };

  const remove = async (image: ProfileImage) => {
    setBusyId(image.image_id);
    try {
      await deleteProfileImage(image.image_id);
      const remaining = images.filter((candidate) => candidate.image_id !== image.image_id);
      const nextPrimary = remaining.find((candidate) => candidate.is_primary) ?? remaining[0];
      await refresh();
      if (image.is_primary) onPrimaryChange?.(nextPrimary?.image_id ?? null);
      message.success('Image removed');
    } catch (nextError) {
      message.error(nextError instanceof Error ? nextError.message : 'Photo could not be removed');
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <Flex vertical gap={token.marginSM} style={{ width: '100%', minWidth: 0 }}>
      <Flex justify="space-between" align="center" gap={token.marginSM} wrap>
        <div style={{ minWidth: 0 }}>
          <Typography.Text strong>{label}</Typography.Text>
          <Typography.Text type="secondary" style={{ display: 'block' }}>
            Pick one main image and keep up to {maxImages} total. You can add several at once.
          </Typography.Text>
        </div>
        {canEdit && (
          <Upload
            accept="image/jpeg,image/png,image/webp"
            multiple
            showUploadList={false}
            beforeUpload={queueUploadBatch}
            disabled={galleryFull || uploading}
          >
            {/* Upload's own `disabled` stops the picker but does not reach a
                custom child, so the button needs it too or a full gallery
                still offers a live-looking control. */}
            <Button icon={<UploadOutlined />} loading={uploading} disabled={galleryFull}>
              {uploading
                ? `Uploading ${uploadProgress.completed}/${uploadProgress.total}`
                : 'Add images'}
            </Button>
          </Upload>
        )}
      </Flex>

      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={<Button onClick={refresh}>Retry</Button>}
        />
      )}

      {loading ? (
        <Skeleton active paragraph={{ rows: 2 }} />
      ) : images.length === 0 ? (
        <Card size="small">
          <Empty
            image={<PictureOutlined style={{ fontSize: 36, color: token.colorTextTertiary }} />}
            description={canEdit ? 'Add an image to personalize this space' : 'No image'}
          />
        </Card>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: compact
              ? 'repeat(2, minmax(0, 1fr))'
              : 'repeat(4, minmax(0, 1fr))',
            gap: token.marginSM,
          }}
        >
          {images.map((image) => (
            <Card
              key={image.image_id}
              size="small"
              styles={{ body: { padding: token.paddingSM } }}
              style={{
                minWidth: 0,
                borderColor: image.is_primary ? token.colorPrimary : undefined,
              }}
            >
              <Flex vertical align="center" gap={token.marginXS}>
                <ProfileImagePreview
                  imageId={image.image_id}
                  variant="small"
                  size={compact ? 72 : 84}
                  shape="square"
                  alt={image.alt_text || image.original_name}
                />
                {image.is_primary ? (
                  <Tag
                    color="processing"
                    icon={<CheckCircleFilled />}
                    style={{ marginInlineEnd: 0 }}
                  >
                    Main
                  </Tag>
                ) : canEdit ? (
                  <Button
                    type="text"
                    size="small"
                    icon={<StarOutlined />}
                    loading={busyId === image.image_id}
                    onClick={() => void makePrimary(image)}
                  >
                    Use
                  </Button>
                ) : null}
                {canEdit && (
                  <Popconfirm
                    title="Remove this image?"
                    description={
                      image.is_primary
                        ? 'Another gallery image will become the main image.'
                        : undefined
                    }
                    okText="Remove"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void remove(image)}
                  >
                    <Button
                      type="text"
                      danger
                      size="small"
                      aria-label={`Remove ${image.original_name}`}
                      icon={<DeleteOutlined />}
                      loading={busyId === image.image_id}
                    />
                  </Popconfirm>
                )}
              </Flex>
            </Card>
          ))}
        </div>
      )}
    </Flex>
  );
}
