import type { ProfileImage, ProfileImageID } from '@agor-live/client';
import {
  listProfileImageThemes,
  normalizeProfileImageTheme,
  profileImageThemeKey,
} from '@agor-live/client';
import { DeleteOutlined, PictureOutlined, UploadOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Flex,
  Popconfirm,
  Skeleton,
  Space,
  Typography,
  theme,
  Upload,
} from 'antd';
import type { RcFile } from 'antd/es/upload/interface';
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProfileImageLightbox } from './ProfileImageLightbox';
import { ProfileImageThemeInput, ProfileImageThemePicker } from './ProfileImageThemeControls';
import { PROFILE_IMAGE_REORDER_MIME, ProfileImageThumbnail } from './ProfileImageThumbnail';
import { type ProfileImageUploadItem, ProfileImageUploadQueue } from './ProfileImageUploadQueue';
import {
  bulkDeleteProfileImages,
  bulkSetProfileImageTheme,
  deleteProfileImage,
  listProfileImages,
  type ProfileImageSubject,
  patchProfileImage,
  reorderProfileImages,
  setTeammateActiveTheme,
  uploadProfileImage,
} from './profileImageApi';
import { publishProfileImageGallery } from './useProfileImageGallery';

const ACCEPTED_PROFILE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PROFILE_IMAGE_UPLOAD_MB = 25;
const MAX_PROFILE_IMAGE_UPLOAD_BYTES = MAX_PROFILE_IMAGE_UPLOAD_MB * 1024 * 1024;
/**
 * Placeholder only, shown for the one frame before the list route answers with
 * the authoritative `max_images`. Mirrors the server's cap so the copy does not
 * flash a smaller number, but the server remains the one that enforces it.
 */
const ASSUMED_MAX_GALLERY_IMAGES = 100;

export function validateProfileImageFile(file: File): string | undefined {
  if (!ACCEPTED_PROFILE_IMAGE_TYPES.has(file.type)) return 'Use a JPEG, PNG, or WebP image';
  if (file.size === 0) return 'Choose a non-empty image';
  if (file.size > MAX_PROFILE_IMAGE_UPLOAD_BYTES)
    return `Images must be ${MAX_PROFILE_IMAGE_UPLOAD_MB} MB or smaller`;
  return undefined;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface ProfileImageGalleryEditorProps {
  subject: ProfileImageSubject;
  canEdit: boolean;
  label: string;
  onPrimaryChange?: (imageId: ProfileImageID | null) => void;
  /**
   * Persisted active theme of a teammate subject. Theme labelling and the
   * active-theme picker only appear for teammate galleries.
   */
  activeTheme?: string;
}

interface QueuedFile {
  id: string;
  file: RcFile;
}

let nextQueueId = 0;

export function ProfileImageGalleryEditor({
  subject,
  canEdit,
  label,
  onPrimaryChange,
  activeTheme: persistedActiveTheme,
}: ProfileImageGalleryEditorProps) {
  const { id: subjectId, type: subjectType } = subject;
  const showThemes = subjectType === 'teammate';
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const [images, setImages] = useState<ProfileImage[]>([]);
  const [maxImages, setMaxImages] = useState(ASSUMED_MAX_GALLERY_IMAGES);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [lightboxId, setLightboxId] = useState<string>();
  const [uploads, setUploads] = useState<ProfileImageUploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const failedFiles = useRef<QueuedFile[]>([]);
  const [uploadTheme, setUploadTheme] = useState('');
  const [bulkTheme, setBulkTheme] = useState('');
  const [activeTheme, setActiveTheme] = useState<string | undefined>(persistedActiveTheme);
  const [themeBusy, setThemeBusy] = useState(false);
  const [draggingId, setDraggingId] = useState<string>();
  const [dropTargetId, setDropTargetId] = useState<string>();
  const [fileDragActive, setFileDragActive] = useState(false);
  const fileDragDepth = useRef(0);

  useEffect(() => setActiveTheme(persistedActiveTheme), [persistedActiveTheme]);

  const publish = useCallback(
    (next: ProfileImage[], max: number) =>
      publishProfileImageGallery(
        { id: subjectId, type: subjectType },
        { images: next, max_images: max }
      ),
    [subjectId, subjectType]
  );

  /** Adopt an authoritative gallery from a mutation response. */
  const adopt = useCallback(
    (result: { images: ProfileImage[]; max_images: number }) => {
      setImages(result.images);
      setMaxImages(result.max_images);
      publish(result.images, result.max_images);
    },
    [publish]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await listProfileImages({ id: subjectId, type: subjectType });
      setImages(result.images);
      setMaxImages(result.max_images);
      publishProfileImageGallery({ id: subjectId, type: subjectType }, result);
    } catch (nextError) {
      setError(errorText(nextError, 'Profile images could not load'));
    } finally {
      setLoading(false);
    }
  }, [subjectId, subjectType]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A selection never outlives the images it names.
  useEffect(() => {
    setSelected((current) => {
      const present = new Set<string>(images.map((image) => image.image_id));
      const kept = [...current].filter((id) => present.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [images]);

  const themes = useMemo(() => listProfileImageThemes(images), [images]);
  const themeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const image of images) {
      const key = profileImageThemeKey(image.theme);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [images]);
  const activeKey = profileImageThemeKey(activeTheme);
  const activeThemeHasImages = Boolean(activeKey && (themeCounts.get(activeKey) ?? 0) > 0);

  // ---- Uploading ---------------------------------------------------------

  const runUploads = async (queued: QueuedFile[]) => {
    setUploading(true);
    failedFiles.current = [];
    const theme = normalizeProfileImageTheme(uploadTheme);
    setUploads((current) => [
      ...current.filter((item) => item.status === 'error' && !queued.some((q) => q.id === item.id)),
      ...queued.map<ProfileImageUploadItem>(({ id, file }) => ({
        id,
        name: file.name,
        status: 'queued',
        progress: 0,
      })),
    ]);
    const patchItem = (id: string, patch: Partial<ProfileImageUploadItem>) =>
      setUploads((current) =>
        current.map((item) => (item.id === id ? { ...item, ...patch } : item))
      );

    let uploaded = 0;
    let failed = 0;
    let createdPrimary: ProfileImageID | undefined;
    try {
      // Keep uploads sequential: the server enforces the gallery cap atomically,
      // and a batch should preserve the order the user selected.
      for (const entry of queued) {
        patchItem(entry.id, { status: 'uploading', progress: 0 });
        try {
          const created = await uploadProfileImage(subject, entry.file, {
            theme,
            onProgress: (fraction) => patchItem(entry.id, { progress: Math.round(fraction * 100) }),
          });
          uploaded += 1;
          if (created.is_primary) createdPrimary = created.image_id;
          patchItem(entry.id, { status: 'done', progress: 100 });
        } catch (nextError) {
          failed += 1;
          failedFiles.current.push(entry);
          patchItem(entry.id, { status: 'error', error: errorText(nextError, 'Upload failed') });
          message.error(`${entry.file.name}: ${errorText(nextError, 'Upload failed')}`);
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
      // Successes leave the queue; failures stay for Retry / Dismiss.
      setUploads((current) => current.filter((item) => item.status === 'error'));
    }
  };

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

    const queued: QueuedFile[] = [];
    for (const file of files) {
      const validationError = validateProfileImageFile(file);
      if (validationError) message.error(`${file.name}: ${validationError}`);
      else queued.push({ id: `upload-${nextQueueId++}`, file });
    }
    if (queued.length === 0) return;
    await runUploads(queued);
  };

  const retryFailedUploads = () => {
    const retry = failedFiles.current;
    if (retry.length > 0 && !uploading) void runUploads(retry);
  };

  const galleryFull = images.length >= maxImages;

  const queueUploadBatch = (file: RcFile, fileList: RcFile[]) => {
    if (file.uid === fileList[0]?.uid) void handleUploadBatch(fileList);
    return Upload.LIST_IGNORE;
  };

  // ---- Drag and drop: files in, tiles reordered --------------------------

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

  const onZoneDragEnter = (event: DragEvent) => {
    if (!canEdit || !hasFiles(event)) return;
    fileDragDepth.current += 1;
    setFileDragActive(true);
  };
  const onZoneDragLeave = (event: DragEvent) => {
    if (!canEdit || !hasFiles(event)) return;
    fileDragDepth.current = Math.max(0, fileDragDepth.current - 1);
    if (fileDragDepth.current === 0) setFileDragActive(false);
  };
  const onZoneDragOver = (event: DragEvent) => {
    if (canEdit && hasFiles(event)) event.preventDefault();
  };
  const onZoneDrop = (event: DragEvent) => {
    if (!canEdit || !hasFiles(event)) return;
    event.preventDefault();
    fileDragDepth.current = 0;
    setFileDragActive(false);
    if (uploading) return;
    const files = Array.from(event.dataTransfer.files) as RcFile[];
    if (files.length > 0) void handleUploadBatch(files);
  };

  const applyOrder = async (orderedIds: string[]) => {
    const byId = new Map<string, ProfileImage>(images.map((image) => [image.image_id, image]));
    const optimistic = orderedIds
      .map((id, position) => {
        const image = byId.get(id);
        return image ? { ...image, position } : undefined;
      })
      .filter((image): image is ProfileImage => Boolean(image));
    setImages(optimistic);
    try {
      adopt(await reorderProfileImages(subject, orderedIds));
    } catch (nextError) {
      message.error(errorText(nextError, 'Photos could not be reordered'));
      await refresh();
    }
  };

  const onTileDragStart = (event: DragEvent, image: ProfileImage) => {
    event.dataTransfer.setData(PROFILE_IMAGE_REORDER_MIME, image.image_id);
    event.dataTransfer.effectAllowed = 'move';
    setDraggingId(image.image_id);
  };
  const onTileDragOver = (event: DragEvent, image: ProfileImage) => {
    if (!draggingId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dropTargetId !== image.image_id) setDropTargetId(image.image_id);
  };
  const onTileDrop = (event: DragEvent, target: ProfileImage) => {
    if (!draggingId) return;
    event.preventDefault();
    const ids: string[] = images.map((image) => image.image_id);
    const from = ids.indexOf(draggingId);
    const to = ids.indexOf(target.image_id);
    setDraggingId(undefined);
    setDropTargetId(undefined);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, draggingId);
    void applyOrder(ids);
  };
  const onTileDragEnd = () => {
    setDraggingId(undefined);
    setDropTargetId(undefined);
  };

  const moveImage = (image: ProfileImage, offset: -1 | 1) => {
    const ids: string[] = images.map((candidate) => candidate.image_id);
    const from = ids.indexOf(image.image_id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, image.image_id);
    void applyOrder(ids);
  };

  // ---- Single-image actions ----------------------------------------------

  const makePrimary = async (image: ProfileImage) => {
    setBusy(true);
    try {
      await patchProfileImage(image.image_id, { is_primary: true });
      await refresh();
      onPrimaryChange?.(image.image_id);
      message.success('Main image updated');
    } catch (nextError) {
      message.error(errorText(nextError, 'Photo could not be updated'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (image: ProfileImage) => {
    setBusy(true);
    try {
      await deleteProfileImage(image.image_id);
      const remaining = images.filter((candidate) => candidate.image_id !== image.image_id);
      const nextPrimary = remaining.find((candidate) => candidate.is_primary) ?? remaining[0];
      if (lightboxId === image.image_id) {
        const index = images.findIndex((candidate) => candidate.image_id === image.image_id);
        setLightboxId(remaining[Math.min(index, remaining.length - 1)]?.image_id);
      }
      await refresh();
      if (image.is_primary) onPrimaryChange?.(nextPrimary?.image_id ?? null);
      message.success('Image removed');
    } catch (nextError) {
      message.error(errorText(nextError, 'Photo could not be removed'));
    } finally {
      setBusy(false);
    }
  };

  const updateImage = async (
    image: ProfileImage,
    patch: { theme?: string | null; alt_text?: string }
  ) => {
    setBusy(true);
    try {
      const updated = await patchProfileImage(image.image_id, patch);
      const next = images.map((candidate) =>
        candidate.image_id === updated.image_id ? updated : candidate
      );
      setImages(next);
      publish(next, maxImages);
    } catch (nextError) {
      message.error(errorText(nextError, 'Photo could not be updated'));
    } finally {
      setBusy(false);
    }
  };

  // ---- Selection and bulk actions -----------------------------------------

  const toggleSelected = (imageId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(imageId)) next.add(imageId);
      return next;
    });
  const allSelected = images.length > 0 && selected.size === images.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(images.map((image) => image.image_id)));

  const bulkRemove = async () => {
    const ids = [...selected];
    const removesPrimary = images.some((image) => image.is_primary && selected.has(image.image_id));
    setBusy(true);
    try {
      const result = await bulkDeleteProfileImages(subject, ids);
      adopt(result);
      setSelected(new Set());
      if (removesPrimary) {
        onPrimaryChange?.(
          (result.images.find((image) => image.is_primary) ?? result.images[0])?.image_id ?? null
        );
      }
      message.success(`${ids.length} image${ids.length === 1 ? '' : 's'} removed`);
    } catch (nextError) {
      message.error(errorText(nextError, 'Photos could not be removed'));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const bulkApplyTheme = async (value: string | null) => {
    const ids = [...selected];
    setBusy(true);
    try {
      adopt(await bulkSetProfileImageTheme(subject, ids, value));
      setSelected(new Set());
      setBulkTheme('');
      message.success(
        value
          ? `${ids.length} image${ids.length === 1 ? '' : 's'} labeled “${value}”`
          : `Theme cleared on ${ids.length} image${ids.length === 1 ? '' : 's'}`
      );
    } catch (nextError) {
      message.error(errorText(nextError, 'Theme could not be applied'));
    } finally {
      setBusy(false);
    }
  };

  const chooseActiveTheme = async (value: string | null) => {
    const previous = activeTheme;
    setActiveTheme(value ?? undefined);
    setThemeBusy(true);
    try {
      const result = await setTeammateActiveTheme(subjectId, value);
      setActiveTheme(result.active_theme ?? undefined);
    } catch (nextError) {
      setActiveTheme(previous);
      message.error(errorText(nextError, 'Theme could not be changed'));
    } finally {
      setThemeBusy(false);
    }
  };

  // ---- Render --------------------------------------------------------------

  const grid = (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))',
        gap: token.marginSM,
      }}
    >
      {images.map((image) => (
        <ProfileImageThumbnail
          key={image.image_id}
          image={image}
          canEdit={canEdit}
          selected={selected.has(image.image_id)}
          dimmed={activeThemeHasImages && profileImageThemeKey(image.theme) !== activeKey}
          dragging={draggingId === image.image_id}
          dropTarget={dropTargetId === image.image_id && draggingId !== image.image_id}
          onOpen={() => setLightboxId(image.image_id)}
          onToggleSelect={() => toggleSelected(image.image_id)}
          onMakePrimary={() => void makePrimary(image)}
          onDragStart={(event) => onTileDragStart(event, image)}
          onDragOver={(event) => onTileDragOver(event, image)}
          onDrop={(event) => onTileDrop(event, image)}
          onDragEnd={onTileDragEnd}
        />
      ))}
    </div>
  );

  return (
    <Flex vertical gap={token.marginSM} style={{ width: '100%', minWidth: 0 }}>
      <Flex justify="space-between" align="center" gap={token.marginSM} wrap>
        <div style={{ minWidth: 0 }}>
          <Typography.Text strong>{label}</Typography.Text>
          <Typography.Text type="secondary" style={{ display: 'block' }}>
            Pick one main image and keep up to {maxImages} total.
            {canEdit && ' Drag photos to reorder, or drop files anywhere here to add them.'}
          </Typography.Text>
        </div>
        <Flex align="center" gap={token.marginXS} wrap>
          {!loading && (
            <Typography.Text type="secondary" data-testid="profile-image-count">
              {images.length} / {maxImages}
            </Typography.Text>
          )}
          {canEdit && images.length > 0 && (
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
              <Button
                icon={<UploadOutlined />}
                loading={uploading}
                disabled={galleryFull || uploading}
              >
                Add images
              </Button>
            </Upload>
          )}
        </Flex>
      </Flex>

      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={<Button onClick={refresh}>Retry</Button>}
        />
      )}

      {showThemes && !loading && images.length > 0 && (
        <ProfileImageThemePicker
          themes={themes}
          counts={themeCounts}
          total={images.length}
          activeTheme={activeTheme}
          canEdit={canEdit}
          busy={themeBusy}
          onSelect={(value) => void chooseActiveTheme(value)}
        />
      )}

      {canEdit && showThemes && (
        <Flex align="center" gap={token.marginXS} wrap>
          <Typography.Text type="secondary">New photos get theme:</Typography.Text>
          <ProfileImageThemeInput
            value={uploadTheme}
            onChange={setUploadTheme}
            themes={themes}
            placeholder="None"
            ariaLabel="Theme for new photos"
            disabled={uploading}
          />
        </Flex>
      )}

      <ProfileImageUploadQueue
        items={uploads}
        uploading={uploading}
        onRetryFailed={retryFailedUploads}
        onDismiss={() => {
          failedFiles.current = [];
          setUploads([]);
        }}
      />

      {canEdit && selected.size > 0 && (
        <Flex
          align="center"
          gap={token.marginSM}
          wrap
          data-testid="profile-image-bulk-bar"
          style={{
            padding: token.paddingSM,
            borderRadius: token.borderRadiusLG,
            background: token.colorPrimaryBg,
          }}
        >
          <Typography.Text strong>{selected.size} selected</Typography.Text>
          {showThemes && (
            <Space.Compact>
              <ProfileImageThemeInput
                value={bulkTheme}
                onChange={setBulkTheme}
                themes={themes}
                placeholder="Set theme…"
                ariaLabel="Theme for selected photos"
                disabled={busy}
                onCommit={(value) => value.trim() && void bulkApplyTheme(value)}
              />
              <Button
                disabled={busy || !normalizeProfileImageTheme(bulkTheme)}
                onClick={() => void bulkApplyTheme(normalizeProfileImageTheme(bulkTheme) ?? null)}
              >
                Apply
              </Button>
              <Button disabled={busy} onClick={() => void bulkApplyTheme(null)}>
                Clear theme
              </Button>
            </Space.Compact>
          )}
          <Popconfirm
            title={`Remove ${selected.size} image${selected.size === 1 ? '' : 's'}?`}
            description={
              images.some((image) => image.is_primary && selected.has(image.image_id))
                ? 'Another gallery image will become the main image.'
                : undefined
            }
            okText="Remove"
            okButtonProps={{ danger: true }}
            onConfirm={() => void bulkRemove()}
          >
            <Button danger icon={<DeleteOutlined />} disabled={busy}>
              Remove
            </Button>
          </Popconfirm>
          <Button type="text" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </Flex>
      )}

      {canEdit && images.length > 0 && (
        <Checkbox
          checked={allSelected}
          indeterminate={selected.size > 0 && !allSelected}
          onChange={toggleAll}
        >
          Select all
        </Checkbox>
      )}

      {loading ? (
        <div
          aria-busy
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))',
            gap: token.marginSM,
          }}
        >
          {Array.from({ length: 8 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <Skeleton.Node key={index} active style={{ width: '100%', height: 104 }}>
              {' '}
            </Skeleton.Node>
          ))}
        </div>
      ) : images.length === 0 ? (
        canEdit ? (
          <Upload.Dragger
            accept="image/jpeg,image/png,image/webp"
            multiple
            showUploadList={false}
            beforeUpload={queueUploadBatch}
            disabled={uploading}
          >
            <p className="ant-upload-drag-icon">
              <PictureOutlined />
            </p>
            <p className="ant-upload-text">Add images: drop photos here, or click to choose</p>
            <p className="ant-upload-hint">
              JPEG, PNG, or WebP up to {MAX_PROFILE_IMAGE_UPLOAD_MB} MB each, up to {maxImages}{' '}
              photos. Add as many as you like at once.
            </p>
          </Upload.Dragger>
        ) : (
          <Empty
            image={<PictureOutlined style={{ fontSize: 36, color: token.colorTextTertiary }} />}
            description="No image"
          />
        )
      ) : (
        <div
          onDragEnter={onZoneDragEnter}
          onDragLeave={onZoneDragLeave}
          onDragOver={onZoneDragOver}
          onDrop={onZoneDrop}
          style={{
            position: 'relative',
            padding: token.paddingXXS,
            borderRadius: token.borderRadiusLG,
            outline: fileDragActive ? `2px dashed ${token.colorPrimary}` : undefined,
          }}
        >
          {grid}
          {fileDragActive && (
            <Flex
              align="center"
              justify="center"
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: token.borderRadiusLG,
                background: token.colorBgMask,
                pointerEvents: 'none',
              }}
            >
              <Typography.Text strong style={{ color: token.colorWhite }}>
                Drop to add photos
              </Typography.Text>
            </Flex>
          )}
        </div>
      )}

      <ProfileImageLightbox
        images={images}
        openImageId={lightboxId}
        canEdit={canEdit}
        showThemes={showThemes}
        themes={themes}
        busy={busy}
        onNavigate={setLightboxId}
        onClose={() => setLightboxId(undefined)}
        onMakePrimary={(image) => void makePrimary(image)}
        onMove={moveImage}
        onRemove={(image) => void remove(image)}
        onUpdate={(image, patch) => void updateImage(image, patch)}
      />
    </Flex>
  );
}
