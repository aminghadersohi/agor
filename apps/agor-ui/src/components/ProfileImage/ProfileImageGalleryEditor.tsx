import type { ProfileImage } from '@agor-live/client';
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

interface ProfileImageGalleryEditorProps {
  subject: ProfileImageSubject;
  canEdit: boolean;
  label: string;
  onPrimaryChange?: (imageId: string | null) => void;
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
  const [maxImages, setMaxImages] = useState(8);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [uploading, setUploading] = useState(false);
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

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const created = await uploadProfileImage(subject, file);
      await refresh();
      if (created.is_primary) onPrimaryChange?.(created.image_id);
      message.success(created.is_primary ? 'Profile photo added' : 'Photo added to gallery');
    } catch (nextError) {
      message.error(nextError instanceof Error ? nextError.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
    return Upload.LIST_IGNORE;
  };

  const makePrimary = async (image: ProfileImage) => {
    setBusyId(image.image_id);
    try {
      await patchProfileImage(image.image_id, { is_primary: true });
      await refresh();
      onPrimaryChange?.(image.image_id);
      message.success('Main profile photo updated');
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
      message.success('Photo removed');
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
            Pick one main photo and keep up to {maxImages} alternatives.
          </Typography.Text>
        </div>
        {canEdit && (
          <Upload
            accept="image/jpeg,image/png,image/webp"
            showUploadList={false}
            beforeUpload={handleUpload}
            disabled={uploading || images.length >= maxImages}
          >
            <Button icon={<UploadOutlined />} loading={uploading}>
              Add photo
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
            description={canEdit ? 'Add a photo to personalize this profile' : 'No profile photo'}
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
                    title="Remove this photo?"
                    description={
                      image.is_primary
                        ? 'Another gallery photo will become the main photo.'
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
