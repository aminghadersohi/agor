import type { AgorClient, Branch, FileDetail, FileListItem } from '@agor-live/client';
import {
  CheckOutlined,
  CloseOutlined,
  CodeOutlined,
  ReloadOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { Alert, App, Button, Empty, Grid, Modal, Space, Spin, Tag, Typography, theme } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useThemedMessage } from '../../utils/message';
import { CodeEditor, type CodeEditorLanguage } from '../CodeEditor';
import type { FileItem } from '../FileCollection/FileCollection';
import { FileCollection } from '../FileCollection/FileCollection';

const { Text } = Typography;

interface WorktreeFileEditorProps {
  branch: Branch;
  client: AgorClient | null;
  files: FileListItem[];
  open: boolean;
  onClose: () => void;
  onFileSaved: (file: FileDetail) => void;
}

function languageForPath(path: string): CodeEditorLanguage {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'markdown';
  return 'text';
}

export const WorktreeFileEditor: React.FC<WorktreeFileEditorProps> = ({
  branch,
  client,
  files,
  open,
  onClose,
  onFileSaved,
}) => {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const compactLayout = !screens.md;
  const { modal } = App.useApp();
  const { showError, showSuccess } = useThemedMessage();
  const [selectedFile, setSelectedFile] = useState<FileDetail | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const dirty = selectedFile !== null && content !== selectedFile.content;
  const editableFiles = useMemo(() => files.filter((file) => file.isText), [files]);

  const confirmDiscard = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true;
    return await new Promise<boolean>((resolve) => {
      modal.confirm({
        title: 'Discard unsaved changes?',
        content: `Your edits to ${selectedFile?.path ?? 'this file'} have not been saved.`,
        okText: 'Discard',
        okButtonProps: { danger: true },
        cancelText: 'Keep editing',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }, [dirty, modal, selectedFile?.path]);

  const loadFile = useCallback(
    async (file: FileItem, options?: { skipDiscardConfirmation?: boolean }) => {
      if (!client || (!options?.skipDiscardConfirmation && !(await confirmDiscard()))) return;
      if (!file.isText) return;
      setLoading(true);
      try {
        const detail = await client.service('file').get(file.path, {
          query: { branch_id: branch.branch_id },
        });
        setSelectedFile(detail);
        setContent(detail.content);
      } catch (error) {
        showError(error instanceof Error ? error.message : 'Failed to open file');
      } finally {
        setLoading(false);
      }
    },
    [branch.branch_id, client, confirmDiscard, showError]
  );

  const save = useCallback(async () => {
    if (!client || !selectedFile || !dirty || saving) return;
    setSaving(true);
    try {
      const saved = await client
        .service('file')
        .patch(
          selectedFile.path,
          { content, expectedLastModified: selectedFile.lastModified },
          { query: { branch_id: branch.branch_id } }
        );
      setSelectedFile(saved);
      setContent(saved.content);
      onFileSaved(saved);
      showSuccess(`Saved ${saved.path}`);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }, [
    branch.branch_id,
    client,
    content,
    dirty,
    onFileSaved,
    saving,
    selectedFile,
    showError,
    showSuccess,
  ]);

  const reload = useCallback(async () => {
    if (!selectedFile || !(await confirmDiscard())) return;
    await loadFile(selectedFile, { skipDiscardConfirmation: true });
  }, [confirmDiscard, loadFile, selectedFile]);

  const requestClose = useCallback(async () => {
    if (await confirmDiscard()) onClose();
  }, [confirmDiscard, onClose]);

  useEffect(() => {
    if (!open) {
      setSelectedFile(null);
      setContent('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, save]);

  return (
    <Modal
      open={open}
      onCancel={() => void requestClose()}
      closable={false}
      footer={null}
      width={compactLayout ? '100vw' : 'calc(100vw - 48px)'}
      centered={!compactLayout}
      destroyOnHidden
      style={compactLayout ? { top: 0, margin: 0, maxWidth: '100vw', paddingBottom: 0 } : undefined}
      styles={{
        body: {
          height: compactLayout ? '100dvh' : 'calc(100dvh - 96px)',
          padding: 0,
          overflow: 'hidden',
        },
      }}
      title={null}
    >
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <header
          style={{
            minHeight: 52,
            padding: `0 ${token.paddingSM}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: token.marginSM,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Space size="small" style={{ minWidth: 0 }}>
            <CodeOutlined style={{ color: token.colorPrimary }} />
            <Text strong ellipsis>
              {branch.name}
            </Text>
            {!compactLayout && <Text type="secondary">Workspace editor</Text>}
          </Space>
          <Space size="small">
            {!compactLayout &&
              (dirty ? (
                <Tag color="gold">Unsaved</Tag>
              ) : selectedFile ? (
                <Tag icon={<CheckOutlined />}>Saved</Tag>
              ) : null)}
            <Button
              icon={<ReloadOutlined />}
              aria-label="Reload file"
              disabled={!selectedFile || loading}
              onClick={() => void reload()}
            >
              {compactLayout ? null : 'Reload'}
            </Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              aria-label="Save file"
              disabled={!dirty}
              loading={saving}
              onClick={() => void save()}
            >
              {compactLayout ? null : 'Save'}
            </Button>
            <Button
              type="text"
              aria-label="Close workspace editor"
              icon={<CloseOutlined />}
              onClick={() => void requestClose()}
            />
          </Space>
        </header>

        <PanelGroup
          direction={compactLayout ? 'vertical' : 'horizontal'}
          style={{ flex: 1, minHeight: 0 }}
        >
          <Panel
            defaultSize={compactLayout ? 34 : 24}
            minSize={compactLayout ? 22 : 16}
            maxSize={compactLayout ? 55 : 42}
          >
            <aside
              aria-label="Worktree files"
              style={{
                height: '100%',
                overflow: 'hidden',
                background: token.colorBgContainer,
                padding: token.paddingSM,
                boxSizing: 'border-box',
              }}
            >
              <Text
                type="secondary"
                style={{
                  display: 'block',
                  marginBottom: token.marginXS,
                  fontSize: token.fontSizeSM,
                }}
              >
                EXPLORER · {editableFiles.length.toLocaleString()} text files
              </Text>
              <FileCollection
                files={files}
                onFileClick={(file) => void loadFile(file)}
                compact
                selectedPath={selectedFile?.path}
                treeHeight={
                  compactLayout
                    ? Math.max(120, Math.floor(window.innerHeight * 0.24))
                    : Math.max(320, window.innerHeight - 205)
                }
                emptyMessage="No worktree files found"
              />
            </aside>
          </Panel>
          <PanelResizeHandle
            aria-label="Resize file explorer"
            style={{
              width: compactLayout ? '100%' : 4,
              height: compactLayout ? 4 : '100%',
              cursor: compactLayout ? 'row-resize' : 'col-resize',
              background: token.colorBorderSecondary,
            }}
          />
          <Panel minSize={compactLayout ? 35 : 40}>
            <main style={{ height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              {selectedFile && (
                <div
                  style={{
                    minHeight: 38,
                    padding: `0 ${token.paddingSM}px`,
                    display: 'flex',
                    alignItems: 'center',
                    borderBottom: `1px solid ${token.colorBorderSecondary}`,
                    background: token.colorFillQuaternary,
                  }}
                >
                  <Text code ellipsis title={selectedFile.path}>
                    {selectedFile.path}
                  </Text>
                </div>
              )}
              <div
                style={{ flex: 1, minHeight: 0, padding: token.paddingSM, position: 'relative' }}
              >
                {loading ? (
                  <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
                    <Spin size="large" />
                  </div>
                ) : selectedFile ? (
                  <CodeEditor
                    value={content}
                    onChange={setContent}
                    language={languageForPath(selectedFile.path)}
                    height="100%"
                  />
                ) : (
                  <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
                    <Empty description="Choose a text file from the explorer" />
                  </div>
                )}
              </div>
              <Alert
                banner
                showIcon
                type="info"
                title="Saves update the worktree directly. Agent and external-editor changes are detected before overwrite."
              />
            </main>
          </Panel>
        </PanelGroup>
      </div>
    </Modal>
  );
};
