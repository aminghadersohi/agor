import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  PauseCircleOutlined,
} from '@ant-design/icons';
import { Button, Flex, Progress, Typography, theme } from 'antd';

export interface ProfileImageUploadItem {
  id: string;
  name: string;
  status: 'queued' | 'uploading' | 'done' | 'error';
  /** 0..100 */
  progress: number;
  error?: string;
}

interface ProfileImageUploadQueueProps {
  items: ProfileImageUploadItem[];
  uploading: boolean;
  onRetryFailed: () => void;
  onDismiss: () => void;
}

/** Per-file progress for the current upload batch, plus failures awaiting retry. */
export function ProfileImageUploadQueue({
  items,
  uploading,
  onRetryFailed,
  onDismiss,
}: ProfileImageUploadQueueProps) {
  const { token } = theme.useToken();
  if (items.length === 0) return null;
  const failed = items.filter((item) => item.status === 'error').length;
  const finished = items.filter((item) => item.status === 'done' || item.status === 'error').length;

  return (
    <Flex
      vertical
      gap={token.marginXS}
      data-testid="profile-image-upload-queue"
      style={{
        padding: token.paddingSM,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        background: token.colorFillQuaternary,
      }}
    >
      <Flex justify="space-between" align="center" gap={token.marginSM} wrap>
        <Typography.Text strong>
          {uploading
            ? `Uploading ${finished} of ${items.length}`
            : failed > 0
              ? `${failed} upload${failed === 1 ? '' : 's'} failed`
              : 'Uploads complete'}
        </Typography.Text>
        {!uploading && (
          <Flex gap={token.marginXS}>
            {failed > 0 && (
              <Button size="small" onClick={onRetryFailed}>
                Retry failed
              </Button>
            )}
            <Button size="small" type="text" onClick={onDismiss}>
              Dismiss
            </Button>
          </Flex>
        )}
      </Flex>
      <div style={{ maxHeight: 168, overflowY: 'auto' }}>
        {items.map((item) => (
          <Flex key={item.id} align="center" gap={token.marginXS} style={{ minWidth: 0 }}>
            <span style={{ width: 16, flexShrink: 0 }} aria-hidden>
              {item.status === 'done' ? (
                <CheckCircleFilled style={{ color: token.colorSuccess }} />
              ) : item.status === 'error' ? (
                <CloseCircleFilled style={{ color: token.colorError }} />
              ) : item.status === 'uploading' ? (
                <LoadingOutlined />
              ) : (
                <PauseCircleOutlined style={{ color: token.colorTextTertiary }} />
              )}
            </span>
            <Typography.Text
              ellipsis={{ tooltip: item.name }}
              style={{ flex: '0 1 40%', minWidth: 0 }}
            >
              {item.name}
            </Typography.Text>
            {item.status === 'error' ? (
              <Typography.Text
                type="danger"
                ellipsis={{ tooltip: item.error }}
                style={{ flex: 1, minWidth: 0 }}
              >
                {item.error ?? 'Upload failed'}
              </Typography.Text>
            ) : (
              <Progress
                percent={item.status === 'queued' ? 0 : item.progress}
                size="small"
                status={item.status === 'done' ? 'success' : 'active'}
                style={{ flex: 1, minWidth: 0, margin: 0 }}
              />
            )}
          </Flex>
        ))}
      </div>
    </Flex>
  );
}
