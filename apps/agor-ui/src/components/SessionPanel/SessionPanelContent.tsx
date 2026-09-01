import type {
  AgorClient,
  Branch,
  CoordinatorQueueBatchApplyResult,
  CoordinatorQueueBatchPreview,
  Session,
  SpawnConfig,
  Task,
} from '@agor-live/client';
import { getTeammateConfig, isTeammate, sessionPath } from '@agor-live/client';
import {
  CopyOutlined,
  DeleteOutlined,
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
import { useTeammateProfileImageUrl } from '../ProfileImage';

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
  /** Conversation-first presentation that hides branch and task chrome. */
  simple?: boolean;
  /** Preserve per-chat reading positions inside the dedicated chat workspace. */
  rememberScrollPosition?: boolean;
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
    simple = false,
    rememberScrollPosition = false,
  }) => {
    const { token } = theme.useToken();
    const teammateConfig = branch && isTeammate(branch) ? getTeammateConfig(branch) : undefined;
    const teammateAvatarUrl = useTeammateProfileImageUrl(branch, 'small');
    const { showSuccess, showError } = useThemedMessage();
    const [resumeQueueInFlight, setResumeQueueInFlight] = React.useState(false);
    const [batchOpen, setBatchOpen] = React.useState(false);
    const [batchLoading, setBatchLoading] = React.useState(false);
    const [batchStrategy, setBatchStrategy] = React.useState<'combine' | 'replace'>('combine');
    const [replacementPrompt, setReplacementPrompt] = React.useState('');
    const [batchPreview, setBatchPreview] = React.useState<CoordinatorQueueBatchPreview | null>(
      null
    );
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
            display: simple ? 'none' : 'flex',
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

        <Divider
          style={{
            display: simple ? 'none' : undefined,
            margin: `${token.sizeUnit * 2}px 0`,
          }}
        />

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
          teammateEmoji={teammateConfig?.emoji}
          teammateAvatarUrl={teammateAvatarUrl}
          forceExpandAll={forceExpandAll}
          onOpenAgenticToolSettings={onOpenAgenticToolSettings}
          simple={simple}
          rememberScrollPosition={rememberScrollPosition}
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
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={async () => {
                        if (!client) return;

                        try {
                          // Optimistically remove from UI
                          setQueuedTasks((prev) => prev.filter((t) => t.task_id !== task.task_id));

                          // Delete the queued task — cascade removes the row
                          // entirely; spawnTaskExecutor never gets a chance.
                          await client.service('tasks').remove(task.task_id);
                        } catch (error) {
                          showError(
                            `Failed to remove queued task: ${error instanceof Error ? error.message : String(error)}`
                          );

                          // Re-fetch queue to restore accurate state
                          const response = await client
                            .service(`sessions/${session.session_id}/tasks/queue`)
                            .find();
                          const data = (response as { data: Task[] }).data || [];
                          setQueuedTasks(data);
                        }
                      }}
                    />
                  </Space>
                </div>
              ))}
            </Space>
          </div>
        )}

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
