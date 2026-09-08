import type {
  AgorClient,
  Branch,
  CoordinatorQueueBatchApplyResult,
  CoordinatorQueueBatchPreview,
  QueuedPromptAmendmentApplyResult,
  QueuedPromptAmendmentPreview,
  Session,
  SpawnConfig,
  Task,
} from '@agor-live/client';
import { getTeammateConfig, isTeammate, sessionPath } from '@agor-live/client';
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Divider,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import React from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useAgorStore } from '../../store/agorStore';
import { selectMcpServerById, selectRepoById, selectUserById } from '../../store/selectors';
import { copyToClipboard } from '../../utils/clipboard';
import { useThemedMessage } from '../../utils/message';
import { BranchHeaderPill } from '../BranchHeaderPill';
import { BranchMetadataRow } from '../BranchMetadataRow';
import { ConversationView } from '../ConversationView';
import { ForkSpawnModal } from '../ForkSpawnModal';
import {
  EDITABLE_QUEUED_PROMPT_MAX_BYTES,
  queuedPromptPreviewIsStale,
  queuedPromptUnavailableReason,
} from './queuedPromptEditorState';

export interface SessionPanelContentProps {
  client: AgorClient | null;
  session: Session;
  branch?: Branch | null;
  currentUserId?: string;
  sessionMcpServerIds?: string[];
  scrollToBottom: (() => void) | null;
  scrollToTop: (() => void) | null;
  setScrollToBottom: (fn: (() => void) | null) => void;
  setScrollToTop: (fn: (() => void) | null) => void;
  queuedTasks: Task[];
  setQueuedTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  spawnModalOpen: boolean;
  setSpawnModalOpen: (open: boolean) => void;
  onSpawnModalConfirm: (config: string | Partial<SpawnConfig>) => Promise<void>;
  inputValueRef: React.RefObject<string>;
  isOpen: boolean;
  /** When true, all task blocks are force-expanded (used by in-session search) */
  forceExpandAll?: boolean;
}

export const SessionPanelContent = React.memo<SessionPanelContentProps>(
  ({
    client,
    session,
    branch = null,
    currentUserId,
    scrollToBottom,
    scrollToTop,
    setScrollToBottom,
    setScrollToTop,
    queuedTasks,
    setQueuedTasks,
    spawnModalOpen,
    setSpawnModalOpen,
    onSpawnModalConfirm,
    inputValueRef,
    isOpen,
    forceExpandAll = false,
  }) => {
    const { token } = theme.useToken();
    const { showSuccess, showError } = useThemedMessage();
    const [resumeQueueInFlight, setResumeQueueInFlight] = React.useState(false);
    const [batchOpen, setBatchOpen] = React.useState(false);
    const [batchLoading, setBatchLoading] = React.useState(false);
    const [batchStrategy, setBatchStrategy] = React.useState<'combine' | 'replace'>('combine');
    const [replacementPrompt, setReplacementPrompt] = React.useState('');
    const [batchPreview, setBatchPreview] = React.useState<CoordinatorQueueBatchPreview | null>(
      null
    );
    const [editTask, setEditTask] = React.useState<Task | null>(null);
    const [editPreview, setEditPreview] = React.useState<QueuedPromptAmendmentPreview | null>(null);
    const [editText, setEditText] = React.useState('');
    const [editLoading, setEditLoading] = React.useState(false);
    const [editConflict, setEditConflict] = React.useState<string | null>(null);
    const editOperationIdRef = React.useRef('');
    const availableBatchRelationships = React.useMemo(() => {
      const relationships: Array<'parent' | 'coordinator'> = [];
      if (session.genealogy?.parent_session_id) relationships.push('parent');
      if (
        session.callback_config?.callback_session_id &&
        session.callback_config.enabled !== false
      ) {
        relationships.push('coordinator');
      }
      return relationships;
    }, [session.callback_config, session.genealogy?.parent_session_id]);
    const [batchRelationship, setBatchRelationship] = React.useState<'parent' | 'coordinator'>(
      availableBatchRelationships.includes('coordinator') ? 'coordinator' : 'parent'
    );
    const batchOperationIdRef = React.useRef<string>('');
    const isQueueHeldByFailure = queuedTasks.length > 0 && session.status === 'failed';
    const editDirty = !!editPreview && editText !== editPreview.canonical_prompt;
    const editBytes = React.useMemo(
      () => new TextEncoder().encode(editText).byteLength,
      [editText]
    );

    const loadEditPreview = React.useCallback(
      async (task = editTask) => {
        if (!client || !task) return;
        setEditLoading(true);
        try {
          const preview = (await client.service(`/tasks/${task.task_id}/queued-prompt`).find({
            query: { sessionId: session.session_id, authority: 'author' },
          })) as unknown as QueuedPromptAmendmentPreview;
          setEditPreview(preview);
          setEditText(preview.canonical_prompt);
          setEditConflict(null);
          editOperationIdRef.current = crypto.randomUUID();
        } catch (error) {
          setEditConflict(error instanceof Error ? error.message : String(error));
        } finally {
          setEditLoading(false);
        }
      },
      [client, editTask, session.session_id]
    );

    const openEditDialog = React.useCallback(
      (task: Task) => {
        setEditTask(task);
        setEditPreview(null);
        setEditText(task.full_prompt);
        setEditConflict(null);
        editOperationIdRef.current = crypto.randomUUID();
        void loadEditPreview(task);
      },
      [loadEditPreview]
    );

    const closeEditDialog = React.useCallback(() => {
      if (editDirty) {
        Modal.confirm({
          title: 'Discard unsaved changes?',
          content: 'Your queued prompt has not been changed.',
          okText: 'Discard',
          okButtonProps: { danger: true },
          onOk: () => setEditTask(null),
        });
        return;
      }
      setEditTask(null);
    }, [editDirty]);

    const mutateQueuedPrompt = React.useCallback(
      async (action: 'update' | 'cancel') => {
        if (!client || !editTask || !editPreview || editLoading) return;
        setEditLoading(true);
        setEditConflict(null);
        try {
          const result = (await client.service(`/tasks/${editTask.task_id}/queued-prompt`).create({
            sessionId: session.session_id,
            authority: 'author',
            action,
            expectedQueueRevision: editPreview.queue_revision,
            expectedPromptRevision: editPreview.prompt_revision,
            idempotencyKey: editOperationIdRef.current,
            ...(action === 'update' ? { revisedPrompt: editText } : {}),
          })) as QueuedPromptAmendmentApplyResult;
          showSuccess(
            action === 'update'
              ? `Queued prompt saved as revision ${result.prompt_revision}`
              : 'Queued prompt cancelled safely'
          );
          setEditTask(null);
        } catch (error) {
          setEditConflict(
            `${error instanceof Error ? error.message : String(error)} Refresh the authoritative prompt before retrying.`
          );
        } finally {
          setEditLoading(false);
        }
      },
      [client, editLoading, editPreview, editTask, editText, session.session_id, showSuccess]
    );

    const refreshEditPreview = React.useCallback(() => {
      if (!editDirty) {
        void loadEditPreview();
        return;
      }
      Modal.confirm({
        title: 'Discard local changes and refresh?',
        content: 'The authoritative queued prompt will replace the unsaved text in this editor.',
        okText: 'Discard and refresh',
        okButtonProps: { danger: true },
        onOk: () => loadEditPreview(),
      });
    }, [editDirty, loadEditPreview]);

    const requestQueuedPromptCancellation = React.useCallback(() => {
      Modal.confirm({
        title: 'Cancel this queued prompt?',
        content:
          'The Task will be settled as stopped and retained with its prompt and amendment audit. It will not be deleted.',
        okText: 'Cancel queued prompt',
        okButtonProps: { danger: true },
        onOk: () => mutateQueuedPrompt('cancel'),
      });
    }, [mutateQueuedPrompt]);

    React.useEffect(() => {
      if (!client || !editTask || !editPreview) return;
      const live = queuedTasks.find((task) => task.task_id === editTask.task_id);
      if (!live) {
        void client
          .service('tasks')
          .get(editTask.task_id)
          .then((task) => {
            setEditConflict(queuedPromptUnavailableReason((task as Task).status));
          })
          .catch(() =>
            setEditConflict('This prompt left the editable queue. Refresh to continue.')
          );
        return;
      }
      if (queuedPromptPreviewIsStale(live, editPreview)) {
        setEditConflict('Another tab changed this queued prompt. Refresh before saving.');
      }
    }, [client, editPreview, editTask, queuedTasks]);

    React.useEffect(() => {
      if (availableBatchRelationships.includes(batchRelationship)) return;
      setBatchRelationship(
        availableBatchRelationships.includes('coordinator') ? 'coordinator' : 'parent'
      );
    }, [availableBatchRelationships, batchRelationship]);

    const loadBatchPreview = React.useCallback(async () => {
      if (!client || !batchOpen) return;
      setBatchLoading(true);
      try {
        const preview = (await client
          .service(`/sessions/${session.session_id}/tasks/queue/batch`)
          .find({
            query: { relationship: batchRelationship },
          })) as unknown as CoordinatorQueueBatchPreview;
        setBatchPreview(preview);
      } catch (error) {
        setBatchPreview(null);
        showError(
          `Cannot preview queue batching: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        setBatchLoading(false);
      }
    }, [batchOpen, batchRelationship, client, session.session_id, showError]);

    React.useEffect(() => {
      void loadBatchPreview();
    }, [loadBatchPreview]);

    const openBatchDialog = React.useCallback(() => {
      batchOperationIdRef.current = crypto.randomUUID();
      setBatchStrategy('combine');
      setReplacementPrompt('');
      setBatchPreview(null);
      setBatchOpen(true);
    }, []);

    const applyQueueBatch = React.useCallback(async () => {
      if (!client || !batchPreview || batchLoading) return;
      setBatchLoading(true);
      try {
        const result = (await client
          .service(`/sessions/${session.session_id}/tasks/queue/batch`)
          .create({
            relationship: batchRelationship,
            strategy: batchStrategy,
            expectedQueueRevision: batchPreview.queue_revision,
            expectedTaskIds: batchPreview.expected_task_ids,
            idempotencyKey: batchOperationIdRef.current,
            ...(batchStrategy === 'replace' ? { replacementPrompt } : {}),
          })) as CoordinatorQueueBatchApplyResult;
        if (result.outcome === 'relationship_changed') {
          throw new Error('Coordinator relationship changed; reopen the preview.');
        }
        setQueuedTasks([result.execution_task]);
        showSuccess(`${result.preview.source_request_count} queued requests will run as one turn`);
        setBatchOpen(false);
      } catch (error) {
        showError(
          `Failed to batch queued instructions: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        setBatchLoading(false);
      }
    }, [
      batchLoading,
      batchPreview,
      batchRelationship,
      batchStrategy,
      client,
      replacementPrompt,
      session.session_id,
      setQueuedTasks,
      showError,
      showSuccess,
    ]);

    const handleResumeHeldQueue = React.useCallback(async () => {
      if (!client || resumeQueueInFlight) return;
      setResumeQueueInFlight(true);
      try {
        await client.service('sessions').patch(session.session_id, { ready_for_prompt: true });
        showSuccess('Resuming queued prompts');
      } catch (error) {
        showError(
          `Failed to resume queue: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        setResumeQueueInFlight(false);
      }
    }, [client, resumeQueueInFlight, session.session_id, showError, showSuccess]);

    // Subscribe only to the entity families this panel needs via narrow store
    // selectors. This keeps the panel insulated from session/branch/board
    // patches and avoids unrelated entity churn (e.g. repo edits invalidating
    // user/MCP consumers): each whole-map selector is a stable module-level
    // reference, so a slice only re-renders this content when its own reference
    // changes.
    const userById = useAgorStore(selectUserById);
    const repoById = useAgorStore(selectRepoById);
    const mcpServerById = useAgorStore(selectMcpServerById);
    // Get actions from context
    const {
      onOpenBranch,
      onStartEnvironment,
      onStopEnvironment,
      onNukeEnvironment,
      onViewLogs,
      onPermissionDecision,
      onOpenAgenticToolSettings,
    } = useAppActions();

    // Get repo from branch
    const repo = branch ? repoById.get(branch.repo_id) || null : null;

    // Stable callback for ConversationView's onScrollRef to prevent breaking React.memo
    const handleScrollRef = React.useCallback(
      (scrollBottom: () => void, scrollTop: () => void) => {
        setScrollToBottom(() => scrollBottom);
        setScrollToTop(() => scrollTop);
      },
      [setScrollToBottom, setScrollToTop]
    );

    return (
      <>
        {/* Header row with pills and scroll navigation */}
        <div
          style={{
            marginBottom: token.sizeUnit,
            display: 'flex',
            // Keep navigation aligned with the branch pill's first row when metadata wraps below it.
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: token.sizeUnit * 2,
          }}
        >
          {/* Pills section (only shown if there's content) */}
          {branch && (
            <BranchMetadataRow branch={branch} repo={repo} style={{ flex: '1 1 0', minWidth: 0 }}>
              {repo && (
                <BranchHeaderPill
                  repo={repo}
                  branch={branch}
                  onOpenBranch={onOpenBranch}
                  onStartEnvironment={onStartEnvironment}
                  onStopEnvironment={onStopEnvironment}
                  onNukeEnvironment={onNukeEnvironment}
                  onViewLogs={onViewLogs}
                  identityLink={sessionPath(session.session_id)}
                  truncateToFit
                />
              )}
            </BranchMetadataRow>
          )}
          {/* Spacer if no pills */}
          {!branch && <div style={{ flex: 1 }} />}
          {/* Scroll Navigation Buttons - always visible */}
          <Space size={4} style={{ flexShrink: 0 }}>
            <Tooltip title="Scroll to top of conversation">
              <Button
                type="text"
                size="small"
                icon={<VerticalAlignTopOutlined />}
                onClick={() => scrollToTop?.()}
                disabled={!scrollToTop}
              />
            </Tooltip>
            <Tooltip title="Scroll to bottom of conversation">
              <Button
                type="text"
                size="small"
                icon={<VerticalAlignBottomOutlined />}
                onClick={() => scrollToBottom?.()}
                disabled={!scrollToBottom}
              />
            </Tooltip>
          </Space>
        </div>

        <Divider style={{ margin: `${token.sizeUnit * 2}px 0` }} />

        <ConversationView
          client={client}
          sessionId={session.session_id}
          agentic_tool={session.agentic_tool}
          sessionModel={session.model_config?.model}
          userById={userById}
          currentUserId={currentUserId}
          onScrollRef={handleScrollRef}
          onPermissionDecision={onPermissionDecision}
          branchName={branch?.name}
          scheduledFromBranch={session.scheduled_from_branch}
          scheduledRunAt={session.scheduled_run_at}
          isActive={isOpen}
          genealogy={session.genealogy}
          teammateEmoji={
            branch && isTeammate(branch) ? getTeammateConfig(branch)?.emoji : undefined
          }
          forceExpandAll={forceExpandAll}
          onOpenAgenticToolSettings={onOpenAgenticToolSettings}
        />

        {/* Queued Tasks Drawer - Above Footer.
            Reads tasks (status='queued') instead of messages now that the queue
            is task-centric (see never-lose-prompt §C). The full prompt lives on
            task.full_prompt; description is the truncated 120-char preview. */}
        {queuedTasks.length > 0 && (
          <div
            style={{
              flexShrink: 0,
              background: token.colorBgElevated,
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              borderTopLeftRadius: token.borderRadiusLG,
              borderTopRightRadius: token.borderRadiusLG,
              padding: `${token.sizeUnit * 3}px ${token.sizeUnit * 6}px`,
              marginLeft: -token.sizeUnit * 6 + token.sizeUnit * 2,
              marginRight: -token.sizeUnit * 6 + token.sizeUnit * 2,
              marginTop: token.sizeUnit * 2,
              boxShadow: `0 -2px 8px ${token.colorBgMask}`,
            }}
          >
            <div
              style={{
                marginBottom: token.sizeUnit * 2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: token.sizeUnit * 2,
              }}
            >
              <Typography.Text
                type="secondary"
                style={{
                  fontSize: token.fontSizeSM,
                  fontWeight: 500,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                }}
              >
                Queued Tasks ({queuedTasks.length})
              </Typography.Text>
              {queuedTasks.length > 1 && availableBatchRelationships.length > 0 && (
                <Button size="small" onClick={openBatchDialog}>
                  Combine queue
                </Button>
              )}
            </div>
            {isQueueHeldByFailure && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: token.sizeUnit * 2 }}
                message="Queue paused by failed session"
                description="Queued prompts are preserved. Resume the queue to run the next prompt without copy/paste."
                action={
                  <Button
                    size="small"
                    type="primary"
                    loading={resumeQueueInFlight}
                    disabled={!client}
                    onClick={handleResumeHeldQueue}
                  >
                    Resume queue
                  </Button>
                }
              />
            )}
            <Space orientation="vertical" size={8} style={{ width: '100%' }}>
              {queuedTasks.map((task, idx) => (
                <div
                  key={task.task_id}
                  style={{
                    background: token.colorBgContainer,
                    padding: `${token.sizeUnit * 2}px ${token.sizeUnit * 3}px`,
                    borderRadius: token.borderRadius,
                    border: `1px solid ${token.colorBorder}`,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: token.sizeUnit * 2,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Typography.Text ellipsis style={{ display: 'block' }}>
                      <span
                        style={{ color: token.colorTextSecondary, marginRight: token.sizeUnit }}
                      >
                        {idx + 1}.
                      </span>
                      {task.full_prompt}
                    </Typography.Text>
                    {task.metadata?.coordinator_queue_batch && (
                      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                        {task.metadata.coordinator_queue_batch.source_request_count} requests became
                        one execution turn ({task.metadata.coordinator_queue_batch.strategy})
                      </Typography.Text>
                    )}
                    <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                      Editable until dispatch/claim
                      {task.metadata?.queued_prompt_amendment
                        ? ` · revision ${task.metadata.queued_prompt_amendment.current_revision}`
                        : ' · original'}
                    </Typography.Text>
                  </div>
                  <Space size={4}>
                    {isQueueHeldByFailure && idx === 0 && (
                      <Button
                        size="small"
                        type="link"
                        loading={resumeQueueInFlight}
                        disabled={!client}
                        onClick={handleResumeHeldQueue}
                      >
                        Run next
                      </Button>
                    )}
                    <Button
                      type="text"
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={async () => {
                        await copyToClipboard(task.full_prompt);
                        showSuccess('Message copied to clipboard');
                      }}
                    />
                    <Tooltip
                      title={
                        currentUserId === task.created_by
                          ? 'Edit or cancel this queued prompt'
                          : 'Only the prompt author can edit here; parent/coordinator access is available through the API/MCP contract.'
                      }
                    >
                      <Button
                        type="text"
                        size="small"
                        icon={<EditOutlined />}
                        aria-label={`Edit queued prompt ${idx + 1}`}
                        disabled={!client || currentUserId !== task.created_by}
                        onClick={() => openEditDialog(task)}
                      />
                    </Tooltip>
                  </Space>
                </div>
              ))}
            </Space>
          </div>
        )}

        <Modal
          open={!!editTask}
          title="Edit queued prompt"
          onCancel={closeEditDialog}
          maskClosable={false}
          destroyOnHidden
          footer={
            <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
              <Button
                danger
                icon={<DeleteOutlined />}
                disabled={!editPreview?.editable || editLoading || !!editConflict}
                onClick={requestQueuedPromptCancellation}
              >
                Cancel queued prompt
              </Button>
              <Space>
                <Button onClick={closeEditDialog}>Close</Button>
                <Button
                  type="primary"
                  loading={editLoading}
                  disabled={
                    !editPreview?.editable ||
                    !editDirty ||
                    !!editConflict ||
                    !editText.trim() ||
                    editBytes > EDITABLE_QUEUED_PROMPT_MAX_BYTES
                  }
                  onClick={() => void mutateQueuedPrompt('update')}
                >
                  Save revision
                </Button>
              </Space>
            </Space>
          }
        >
          <Space orientation="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="Editable until dispatch/claim"
              description="Saving changes the canonical instruction for this Task only. Original text, authorship, timestamps, and every revision remain in its audit trail. Running work is never rewritten."
            />
            {editConflict && (
              <Alert
                type="error"
                showIcon
                message="Authoritative queue changed"
                description={editConflict}
                action={
                  <Button size="small" loading={editLoading} onClick={refreshEditPreview}>
                    Refresh
                  </Button>
                }
              />
            )}
            {editPreview && !editPreview.editable && (
              <Alert
                type="warning"
                showIcon
                message="Not editable"
                description={editPreview.refusal_reason}
              />
            )}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                gap: token.sizeUnit,
              }}
            >
              <Typography.Text type="secondary">
                Revision {editPreview?.prompt_revision ?? 0} · authored{' '}
                {editPreview?.created_at ? new Date(editPreview.created_at).toLocaleString() : '—'}
              </Typography.Text>
              <Typography.Text
                type={editBytes > 32 * 1024 ? 'danger' : 'secondary'}
                aria-live="polite"
              >
                {editBytes.toLocaleString()} / {EDITABLE_QUEUED_PROMPT_MAX_BYTES.toLocaleString()}{' '}
                bytes
              </Typography.Text>
            </div>
            <Input.TextArea
              autoFocus
              value={editText}
              disabled={!editPreview?.editable || editLoading}
              onChange={(event) => setEditText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  if (
                    editPreview?.editable &&
                    editDirty &&
                    !editConflict &&
                    editText.trim() &&
                    editBytes <= EDITABLE_QUEUED_PROMPT_MAX_BYTES
                  ) {
                    void mutateQueuedPrompt('update');
                  }
                }
              }}
              autoSize={{ minRows: 8, maxRows: 18 }}
              aria-label="Canonical queued prompt"
              aria-describedby="queued-prompt-editor-help"
            />
            <Typography.Text id="queued-prompt-editor-help" type="secondary">
              Press ⌘/Ctrl+Enter to save. Escape or Close preserves unsaved-change protection.
            </Typography.Text>
            {(editPreview?.amendment?.revisions.length ?? 0) > 0 && (
              <details>
                <summary>
                  Provenance: original plus {editPreview!.amendment!.revisions.length} durable{' '}
                  {editPreview!.amendment!.revisions.length === 1 ? 'revision' : 'revisions'}
                </summary>
                <Space orientation="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
                  <Typography.Text strong>
                    Original · {editPreview!.created_at} · {editPreview!.created_by}
                  </Typography.Text>
                  <Typography.Paragraph
                    copyable
                    style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}
                  >
                    {editPreview!.amendment!.original_prompt}
                  </Typography.Paragraph>
                  {editPreview!.amendment!.revisions.map((revision) => (
                    <div key={revision.operation_id}>
                      <Typography.Text strong>
                        Revision {revision.revision} · {revision.amended_at} ·{' '}
                        {revision.amended_by_user_id} via {revision.authority}
                      </Typography.Text>
                      <Typography.Paragraph
                        copyable
                        style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}
                      >
                        {revision.text}
                      </Typography.Paragraph>
                    </div>
                  ))}
                </Space>
              </details>
            )}
          </Space>
        </Modal>

        <Modal
          open={batchOpen}
          title="Batch queued instructions"
          onCancel={() => setBatchOpen(false)}
          okText={batchStrategy === 'combine' ? 'Combine queue' : 'Replace queued instructions'}
          okButtonProps={{
            danger: batchStrategy === 'replace',
            disabled:
              !batchPreview?.compatible ||
              (batchStrategy === 'combine' && !batchPreview.combine_allowed) ||
              (batchStrategy === 'replace' && !replacementPrompt.trim()),
          }}
          confirmLoading={batchLoading}
          onOk={() => void applyQueueBatch()}
        >
          <Space orientation="vertical" size={12} style={{ width: '100%' }}>
            {availableBatchRelationships.length > 1 && (
              <Select
                value={batchRelationship}
                onChange={setBatchRelationship}
                options={availableBatchRelationships.map((relationship) => ({
                  value: relationship,
                  label: relationship === 'parent' ? 'Branch-local parent' : 'Callback coordinator',
                }))}
                style={{ width: '100%' }}
              />
            )}
            <Radio.Group
              value={batchStrategy}
              onChange={(event) => setBatchStrategy(event.target.value)}
              optionType="button"
              buttonStyle="solid"
              options={[
                { label: 'Combine queue', value: 'combine' },
                { label: 'Replace queued instructions', value: 'replace' },
              ]}
            />
            {batchPreview && (
              <div
                style={{ display: 'flex', justifyContent: 'space-between', gap: token.sizeUnit }}
              >
                <Typography.Text type="secondary">
                  {batchPreview.source_task_count} Tasks / {batchPreview.source_request_count}{' '}
                  requests → 1 execution turn; {batchPreview.duplicate_request_count} normalized
                  duplicates omitted from executor bytes.
                </Typography.Text>
                <Button size="small" loading={batchLoading} onClick={() => void loadBatchPreview()}>
                  Refresh
                </Button>
              </div>
            )}
            {batchPreview && !batchPreview.compatible && (
              <Alert
                type="error"
                showIcon
                message="This queue cannot be batched safely"
                description={batchPreview.refusal_reasons.join(' ')}
              />
            )}
            {batchPreview?.compatible &&
              batchStrategy === 'combine' &&
              !batchPreview.combine_allowed && (
                <Alert
                  type="warning"
                  showIcon
                  message="Combined prompt is too large"
                  description={`${batchPreview.combine_refusal_reason} Replace remains available and is never truncated.`}
                />
              )}
            {batchStrategy === 'combine' ? (
              <>
                <Alert
                  type="info"
                  showIcon
                  message="Distinct instructions are preserved"
                  description="Order is deterministic, normalized duplicates are omitted, and the executor is told that later instructions override earlier ones only when they conflict. Switch to Replace to edit a canonical correction."
                />
                <Input.TextArea
                  value={batchPreview?.combined_prompt ?? ''}
                  readOnly
                  autoSize={{ minRows: 6, maxRows: 12 }}
                  aria-label="Combined executor prompt preview"
                />
              </>
            ) : (
              <>
                <Alert
                  type="warning"
                  showIcon
                  message="Only this replacement is sent"
                  description="Every original Task, author, timestamp, request ID, and text remains in audit history, but original instructions are omitted from executor bytes."
                />
                <Input.TextArea
                  value={replacementPrompt}
                  onChange={(event) => setReplacementPrompt(event.target.value)}
                  autoSize={{ minRows: 6, maxRows: 12 }}
                  placeholder="Enter the canonical replacement instructions"
                  aria-label="Canonical replacement instructions"
                />
              </>
            )}
          </Space>
        </Modal>

        {/* Advanced Spawn Modal */}
        <ForkSpawnModal
          open={spawnModalOpen}
          action="spawn"
          session={session}
          currentUser={currentUserId ? userById.get(currentUserId) || null : null}
          mcpServerById={mcpServerById}
          initialPrompt={inputValueRef.current ?? ''}
          onConfirm={onSpawnModalConfirm}
          onCancel={() => setSpawnModalOpen(false)}
          client={client}
          userById={userById}
        />
      </>
    );
  }
);
