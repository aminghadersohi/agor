import type {
  AgorClient,
  Board,
  Branch,
  BranchArchiveOrDeleteOptions,
  Repo,
  SpawnConfig,
} from '@agor-live/client';
import { getTeammateConfig, hasMinimumRole, isTeammate, ROLES } from '@agor-live/client';
import { ExpandAltOutlined, LeftOutlined, PlusOutlined, ToolOutlined } from '@ant-design/icons';
import {
  Badge,
  Button,
  Drawer,
  Empty,
  Select,
  Skeleton,
  Space,
  Spin,
  Tabs,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useBoardPartition } from '../../hooks/useBoardPartition';
import { useCanManageBoard } from '../../hooks/useCanManageBoard';
import { type AgorState, useAgorStore } from '../../store/agorStore';
import { makeBoardPartitionSelector } from '../../store/boardPartitions';
import {
  selectBranchById,
  selectCommentById,
  selectRepoById,
  selectSessionsByBranch,
  selectUserById,
} from '../../store/selectors';
import { selectTeammatesLoaded } from '../../store/userScope';
import { formatActionError } from '../../utils/connectionErrors';
import { mapToArray } from '../../utils/mapHelpers';
import { useThemedMessage } from '../../utils/message';
import { BranchSessionSections } from '../BranchCard';
import { BranchFilesystemRecovery } from '../BranchFilesystemRecovery';
import { BranchHeaderPill } from '../BranchHeaderPill';
import { BoardBranchList, BoardSessionList } from '../BranchListDrawer';
import { BranchMetadataRow } from '../BranchMetadataRow';
import type { BranchModalTab } from '../BranchModal';
import { CommentsPanel } from '../CommentsPanel';
import { CompactNotice } from '../CompactNotice';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { TeammateBoardPortrait } from '../ProfileImage';
import { BoardPartitionError } from '../SessionCanvas/BoardPartitionStatus';
import { TeammateSkillsPanel } from '../TeammateSkillsPanel';

type TeammateLookup =
  | { status: 'loading' }
  | { status: 'found'; branch: Branch }
  | { status: 'archived' }
  | { status: 'denied' }
  | { status: 'failed'; error: string };

/**
 * A board's primary teammate missing from the store may be archived, hidden from
 * this viewer, or just outside the loaded teammate list; ask the server which.
 */
function usePrimaryTeammateLookup(
  client: AgorClient | null,
  teammateId: string | undefined,
  enabled: boolean
): { lookup: TeammateLookup; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const key = `${teammateId}:${attempt}`;
  const [result, setResult] = useState<{
    client: AgorClient;
    key: string;
    lookup: TeammateLookup;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !client || !teammateId) return;
    let cancelled = false;
    client
      .service('branches')
      .get(teammateId)
      .then(
        (branch: Branch) => {
          if (cancelled) return;
          setResult({
            client,
            key,
            lookup: branch.archived ? { status: 'archived' } : { status: 'found', branch },
          });
        },
        (error: unknown) => {
          if (cancelled) return;
          const code = (error as { code?: unknown } | null)?.code;
          setResult({
            client,
            key,
            lookup:
              code === 403 || code === 404
                ? { status: 'denied' }
                : {
                    status: 'failed',
                    error: error instanceof Error ? error.message : String(error),
                  },
          });
        }
      );
    return () => {
      cancelled = true;
    };
  }, [enabled, client, teammateId, key]);

  return {
    // A new sign-in brings a new client, so the previous user's answer is never shown.
    lookup: result?.client === client && result.key === key ? result.lookup : { status: 'loading' },
    retry: useCallback(() => setAttempt((n) => n + 1), []),
  };
}

export type BoardTeammatePanelTab =
  | 'board'
  | 'teammate'
  | 'all-sessions'
  | 'all-branches'
  | 'comments';

type TeammatePortraitSize = 'tiny' | 'small' | 'medium' | 'large' | 'fill';

const TEAMMATE_PORTRAIT_SIZE_STORAGE_KEY = 'agor:teammate-panel-portrait-size';
const TEAMMATE_PORTRAIT_DEFAULT_SIZE: TeammatePortraitSize = 'large';
/**
 * The server stores gallery images at two fixed widths and the larger is 768px
 * (`PROFILE_IMAGE_LARGE_SIZE` in the daemon, which the UI cannot import), so a
 * portrait wider than that is upscaling a variant that has no more detail.
 */
const TEAMMATE_PORTRAIT_FILL_MAX_PX = 768;

interface TeammatePortraitDimensions {
  primary: number;
  alternative: number;
  maxAlternatives?: number;
  /** Track the panel's width, with `primary` acting as the upper bound. */
  fill?: boolean;
}

const TEAMMATE_PORTRAIT_SIZES: Record<TeammatePortraitSize, TeammatePortraitDimensions> = {
  // The 36px identity box the panel header carried before the portrait became a
  // hero element. It also drops the alternates strip, which at this scale would
  // be an 18px thumbnail overlapping a 36px avatar.
  tiny: { primary: 36, alternative: 18, maxAlternatives: 0 },
  small: { primary: 112, alternative: 26 },
  medium: { primary: 200, alternative: 32 },
  large: { primary: 300, alternative: 40 },
  fill: { primary: TEAMMATE_PORTRAIT_FILL_MAX_PX, alternative: 44, fill: true },
};
const TEAMMATE_PORTRAIT_SIZE_ORDER: TeammatePortraitSize[] = [
  'tiny',
  'small',
  'medium',
  'large',
  'fill',
];
const TEAMMATE_PORTRAIT_SIZE_LABELS: Record<TeammatePortraitSize, string> = {
  tiny: 'tiny',
  small: 'small',
  medium: 'medium',
  large: 'large',
  fill: 'panel width',
};

function nextTeammatePortraitSize(current: TeammatePortraitSize): TeammatePortraitSize {
  const currentIndex = TEAMMATE_PORTRAIT_SIZE_ORDER.indexOf(current);
  return TEAMMATE_PORTRAIT_SIZE_ORDER[(currentIndex + 1) % TEAMMATE_PORTRAIT_SIZE_ORDER.length];
}

function initialTeammatePortraitSize(): TeammatePortraitSize {
  try {
    const stored = localStorage.getItem(TEAMMATE_PORTRAIT_SIZE_STORAGE_KEY);
    // Membership in the size table rather than a literal list, so a name that
    // was valid when it was written keeps working and only a name this build
    // cannot render falls back.
    if (stored !== null && Object.hasOwn(TEAMMATE_PORTRAIT_SIZES, stored)) {
      return stored as TeammatePortraitSize;
    }
  } catch {
    // Storage can be unavailable in embedded/private browsing contexts.
  }
  return TEAMMATE_PORTRAIT_DEFAULT_SIZE;
}

interface BoardTeammatePanelProps {
  board: Board | null;
  /** Content of a leading "Board" tab (the mobile board view). */
  boardTab?: React.ReactNode;
  showBranchesTab?: boolean;
  /** Touch-size tabs (44px, 14px labels) for the mobile board screen. */
  touch?: boolean;
  activeTab?: BoardTeammatePanelTab;
  onTabChange?: (tab: BoardTeammatePanelTab) => void;
  primaryTeammateBranch?: Branch;
  primaryTeammateRepo?: Repo;
  primaryTeammateInaccessible: boolean;
  /**
   * Whether the board's partition is complete. Until it is, an absent teammate
   * branch or empty session list means "not loaded yet", so both tabs show a
   * skeleton instead of empty/inaccessible states. Defaults to ready.
   */
  boardReady?: boolean;
  currentUserId?: string;
  selectedSessionId?: string | null;
  onSessionClick: (sessionId: string) => void;
  onCreateSession?: (branchId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onArchiveOrDelete?: (
    branchId: string,
    options: BranchArchiveOrDeleteOptions
  ) => void | Promise<void>;
  onOpenSettings?: (branchId: string, tab?: BranchModalTab) => void;
  onOpenSessionSettings?: (sessionId: string) => void;
  onOpenTerminal?: (commands: string[], branchId?: string) => void;
  onStartEnvironment?: (branchId: string) => void;
  onStopEnvironment?: (branchId: string) => void;
  onViewLogs?: (branchId: string) => void;
  onNukeEnvironment?: (branchId: string) => void;
  onExecuteScheduleNow?: (branchId: string) => Promise<void>;
  onSendComment?: (content: string) => void;
  onReplyComment?: (parentId: string, content: string) => void;
  onResolveComment?: (commentId: string) => void;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDeleteComment?: (commentId: string) => void;
  hoveredCommentId?: string | null;
  selectedCommentId?: string | null;
  unreadCommentsCount?: number;
  hasUserMentions?: boolean;
  onCollapse?: () => void;
  /** Opens teammate creation targeted at this board (it becomes the primary). */
  onCreateTeammate?: () => void;
  deferSessionDetails?: boolean;
  onDeferredDetailsHydrated?: () => void;
  client: AgorClient | null;
}

const BoardTeammatePanelComponent: React.FC<BoardTeammatePanelProps> = ({
  board,
  boardTab,
  showBranchesTab = true,
  touch = false,
  activeTab: controlledActiveTab,
  onTabChange,
  primaryTeammateBranch: storedTeammateBranch,
  primaryTeammateRepo: storedTeammateRepo,
  primaryTeammateInaccessible,
  boardReady = true,
  currentUserId,
  selectedSessionId,
  onSessionClick,
  onCreateSession,
  onForkSession,
  onSpawnSession,
  onOpenSettings,
  onOpenSessionSettings,
  onSendComment,
  onReplyComment,
  onResolveComment,
  onToggleReaction,
  onDeleteComment,
  hoveredCommentId,
  selectedCommentId,
  unreadCommentsCount = 0,
  hasUserMentions = false,
  onCollapse,
  onCreateTeammate,
  deferSessionDetails = false,
  onDeferredDetailsHydrated,
  client,
}) => {
  const { token } = theme.useToken();
  const { showError, showSuccess } = useThemedMessage();
  // Subscribe to entity maps by slice from the store: each selector only wakes
  // this panel when its own slice changes.
  const sessionsByBranch = useAgorStore(selectSessionsByBranch);
  const branchById = useAgorStore(selectBranchById);
  // The assign list is the user scope's teammates (U3): empty means none only once it lands.
  const teammatesLoaded = useAgorStore(selectTeammatesLoaded);
  const repoById = useAgorStore(selectRepoById);
  const userById = useAgorStore(selectUserById);
  const commentById = useAgorStore(selectCommentById);
  const boardObjects = board?.objects;
  const currentUser = currentUserId ? userById.get(currentUserId) : undefined;
  const canEditBoard = useCanManageBoard(client, board ?? undefined, currentUser);
  const { lookup: teammateLookup, retry: retryTeammateLookup } = usePrimaryTeammateLookup(
    client,
    board?.primary_teammate_id,
    primaryTeammateInaccessible
  );
  const primaryTeammateBranch =
    storedTeammateBranch ??
    (primaryTeammateInaccessible && teammateLookup.status === 'found'
      ? teammateLookup.branch
      : undefined);
  const primaryTeammateRepo =
    storedTeammateRepo ??
    (primaryTeammateBranch ? repoById.get(primaryTeammateBranch.repo_id) : undefined);
  // A primary whose branch or repo is not loaded yet must not be offered for replacement.
  const canCreateTeammate =
    canEditBoard && !!onCreateTeammate && !board?.primary_teammate_id && !primaryTeammateBranch;
  const defaultTab: BoardTeammatePanelTab = primaryTeammateInaccessible
    ? 'all-sessions'
    : 'teammate';
  const [uncontrolledActiveTab, setUncontrolledActiveTab] =
    useState<BoardTeammatePanelTab>(defaultTab);
  const [teammatePortraitSize, setTeammatePortraitSize] = useState<TeammatePortraitSize>(
    initialTeammatePortraitSize
  );
  // Fork: the read-only Skills view opens in a drawer. The tab bar has no
  // room for a fifth tab at the panel's 320px minimum width.
  const [skillsOpen, setSkillsOpen] = useState(false);
  const teammatePortraitDimensions = TEAMMATE_PORTRAIT_SIZES[teammatePortraitSize];
  const nextPortraitSize = nextTeammatePortraitSize(teammatePortraitSize);
  const portraitSizeControlLabel = `Portrait size: ${TEAMMATE_PORTRAIT_SIZE_LABELS[teammatePortraitSize]}. Click for ${TEAMMATE_PORTRAIT_SIZE_LABELS[nextPortraitSize]}.`;
  const cycleTeammatePortraitSize = useCallback(() => {
    setTeammatePortraitSize((currentSize) => {
      const nextSize = nextTeammatePortraitSize(currentSize);
      try {
        localStorage.setItem(TEAMMATE_PORTRAIT_SIZE_STORAGE_KEY, nextSize);
      } catch {
        // The in-memory choice still works when storage is unavailable.
      }
      return nextSize;
    });
  }, []);
  const isControlled = controlledActiveTab !== undefined;
  const activeTab = controlledActiveTab ?? uncontrolledActiveTab;
  const [sessionDetailsHydrated, setSessionDetailsHydrated] = useState(() => !deferSessionDetails);
  useEffect(() => {
    setSessionDetailsHydrated(!deferSessionDetails);
  }, [deferSessionDetails]);

  const hydrateDeferredDetails = useCallback(() => {
    if (sessionDetailsHydrated) return;
    setSessionDetailsHydrated(true);
    onDeferredDetailsHydrated?.();
  }, [onDeferredDetailsHydrated, sessionDetailsHydrated]);

  useEffect(() => {
    if (!deferSessionDetails || sessionDetailsHydrated) return;

    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let idleCallbackId: number | undefined;
    const hydrate = () => hydrateDeferredDetails();

    if ('requestIdleCallback' in window) {
      idleCallbackId = window.requestIdleCallback(hydrate, { timeout: 2500 });
    } else {
      fallbackTimer = globalThis.setTimeout(hydrate, 2000);
    }

    return () => {
      if (idleCallbackId !== undefined) window.cancelIdleCallback?.(idleCallbackId);
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
    };
  }, [deferSessionDetails, hydrateDeferredDetails, sessionDetailsHydrated]);

  const setActiveTab = (tab: BoardTeammatePanelTab) => {
    hydrateDeferredDetails();
    setUncontrolledActiveTab(tab);
    onTabChange?.(tab);
  };

  // Derive board comments only when the comments tab is actually visible. The
  // default teammate tab does not need to scan the global comment map during
  // Home → board navigation.
  const comments = useMemo(
    () =>
      activeTab === 'comments'
        ? mapToArray(commentById).filter((c) => c.board_id === board?.board_id)
        : [],
    [activeTab, commentById, board?.board_id]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the tab when switching boards, even if the default tab string is unchanged.
  useEffect(() => {
    setUncontrolledActiveTab(defaultTab);
    if (!isControlled) {
      onTabChange?.(defaultTab);
    }
  }, [defaultTab, board?.board_id, isControlled, onTabChange]);

  const branchOwners = useMemo(() => {
    const ownerId =
      primaryTeammateBranch?.primary_owner_user_id ?? primaryTeammateBranch?.created_by;
    if (!ownerId) return [];
    const owner = userById.get(ownerId);
    return owner ? [owner] : [];
  }, [primaryTeammateBranch?.primary_owner_user_id, primaryTeammateBranch?.created_by, userById]);

  const teammateOptions = useMemo(() => {
    if (primaryTeammateBranch || primaryTeammateInaccessible) return [];

    return Array.from(branchById.values())
      .filter((branch) => isTeammate(branch) && !branch.archived)
      .sort((a, b) => {
        const aConfig = getTeammateConfig(a);
        const bConfig = getTeammateConfig(b);
        return (aConfig?.displayName ?? a.name).localeCompare(bConfig?.displayName ?? b.name);
      })
      .map((branch) => {
        const config = getTeammateConfig(branch);
        const repo = repoById.get(branch.repo_id);
        const label = config?.displayName ?? branch.name;
        return {
          value: branch.branch_id,
          label,
          searchText: `${label} ${branch.name} ${repo?.slug ?? ''}`,
          branch,
          repo,
        };
      });
  }, [branchById, primaryTeammateBranch, primaryTeammateInaccessible, repoById]);
  const [selectedTeammateId, setSelectedTeammateId] = useState<string | undefined>();
  const [assigningTeammate, setAssigningTeammate] = useState(false);

  useEffect(() => {
    if (
      selectedTeammateId &&
      teammateOptions.some((option) => option.value === selectedTeammateId)
    ) {
      return;
    }
    setSelectedTeammateId(teammateOptions[0]?.value);
  }, [teammateOptions, selectedTeammateId]);

  const handleAssignTeammate = async () => {
    if (!board || !client || !selectedTeammateId || !canEditBoard) return;

    const teammate = branchById.get(selectedTeammateId);
    if (!teammate) return;

    setAssigningTeammate(true);
    try {
      // The server performs any board move and assignment atomically through
      // the same branch relocation path used by BranchModal Save.
      await client.service('boards').setPrimaryTeammate({
        boardId: board.board_id,
        branchId: selectedTeammateId,
      });
      showSuccess('Teammate assigned');
    } catch (error) {
      showError(formatActionError('assign the teammate', error, { idempotent: true }));
    } finally {
      setAssigningTeammate(false);
    }
  };

  // A primary teammate on another board: its sessions come with that board's
  // partition, loaded in the background (the shown board stays displayed).
  const teammateBoardId = primaryTeammateBranch?.board_id;
  const { boardReady: teammateBoardReady, status: teammateBoardStatus } = useBoardPartition(
    client,
    teammateBoardId !== board?.board_id ? teammateBoardId : null,
    {
      canUseMemberWorkspaceServices: hasMinimumRole(
        currentUserId ? userById.get(currentUserId)?.role : undefined,
        ROLES.MEMBER
      ),
      background: true,
    }
  );
  const teammateSessions = useMemo(
    () =>
      primaryTeammateBranch ? sessionsByBranch.get(primaryTeammateBranch.branch_id) || [] : [],
    [primaryTeammateBranch, sessionsByBranch]
  );

  // Subscribes to the failed flag only, so other partition entry changes don't re-render the panel.
  const boardFailed = useAgorStore(
    useMemo(() => {
      const selectPartition = makeBoardPartitionSelector(board?.board_id);
      return (s: AgorState) => selectPartition(s)?.status === 'error';
    }, [board?.board_id])
  );
  /** A board still loading; a failed load offers Retry instead of loading forever. */
  const boardLoading = (failedBoardId?: string) =>
    failedBoardId ? (
      <BoardPartitionError
        boardId={failedBoardId}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: token.marginXS,
          padding: token.padding,
        }}
      />
    ) : (
      boardLoadingSkeleton
    );
  const boardLoadingSkeleton = (
    <div style={{ padding: 16 }} data-testid="board-partition-skeleton">
      <Space orientation="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Loading board…
        </Typography.Text>
        <Skeleton active paragraph={{ rows: 4 }} title={false} />
      </Space>
    </div>
  );

  const teammateContent = (() => {
    // No board (or one that doesn't exist): nothing is loading.
    if (board && !boardReady) return boardLoading(boardFailed ? board.board_id : undefined);
    if (board && !teammateBoardReady) {
      return boardLoading(teammateBoardStatus === 'error' ? teammateBoardId : undefined);
    }

    if (primaryTeammateBranch && primaryTeammateRepo) {
      const teammateConfig = getTeammateConfig(primaryTeammateBranch);
      const teammateDescription = primaryTeammateBranch.notes?.trim();
      const isCreating = primaryTeammateBranch.filesystem_status === 'creating';

      return (
        <div
          style={{
            padding: 16,
            height: '100%',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              flexShrink: 0,
              paddingBottom: 12,
              marginBottom: 4,
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                minWidth: 0,
                paddingBlock: 4,
              }}
            >
              <div
                style={{
                  width: '100%',
                  // At the fill step `primary` is only a cap, so reserving it
                  // as a minimum would hold open 768px of empty header.
                  minHeight: teammatePortraitDimensions.fill
                    ? undefined
                    : teammatePortraitDimensions.primary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative',
                }}
              >
                <Tooltip title="Skills">
                  <Button
                    type="text"
                    shape="circle"
                    icon={<ToolOutlined />}
                    aria-label="Open skills"
                    onClick={() => setSkillsOpen(true)}
                    style={{ position: 'absolute', insetInlineStart: 0, top: 0, zIndex: 1 }}
                  />
                </Tooltip>
                <Tooltip title={portraitSizeControlLabel}>
                  <Button
                    type="text"
                    shape="circle"
                    icon={<ExpandAltOutlined />}
                    aria-label={portraitSizeControlLabel}
                    onClick={cycleTeammatePortraitSize}
                    style={{ position: 'absolute', insetInlineEnd: 0, top: 0, zIndex: 1 }}
                  />
                </Tooltip>
                {isCreating ? (
                  <Spin />
                ) : (
                  <TeammateBoardPortrait
                    branch={primaryTeammateBranch}
                    primarySize={teammatePortraitDimensions.primary}
                    alternativeSize={teammatePortraitDimensions.alternative}
                    maxAlternatives={teammatePortraitDimensions.maxAlternatives}
                    fill={teammatePortraitDimensions.fill}
                  />
                )}
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  minWidth: 0,
                  width: '100%',
                }}
              >
                <Typography.Title
                  level={4}
                  style={{ margin: 0, fontWeight: 600, maxWidth: '100%', textAlign: 'center' }}
                  ellipsis={{
                    tooltip: teammateConfig?.displayName ?? primaryTeammateBranch.name,
                  }}
                >
                  {teammateConfig?.displayName ?? primaryTeammateBranch.name}
                </Typography.Title>
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  Primary teammate
                </Typography.Text>
              </div>
            </div>

            <BranchFilesystemRecovery
              branch={primaryTeammateBranch}
              client={client}
              currentUser={currentUser}
            />
            <BranchMetadataRow
              branch={primaryTeammateBranch}
              repo={primaryTeammateRepo}
              owners={branchOwners}
              currentUserId={currentUserId}
              style={{ minWidth: 0 }}
            >
              <BranchHeaderPill
                repo={primaryTeammateRepo}
                branch={primaryTeammateBranch}
                sessionCount={teammateSessions.length}
                onOpenBranch={onOpenSettings}
                showEnvButtons={false}
                compact
                truncateToFit
              />
            </BranchMetadataRow>
            {teammateDescription && (
              <div className="markdown-compact" style={{ color: token.colorTextSecondary }}>
                <MarkdownRenderer content={teammateDescription} compact showControls={false} />
              </div>
            )}
          </div>

          <Drawer
            open={skillsOpen}
            onClose={() => setSkillsOpen(false)}
            title={null}
            aria-label="Skills"
            closable={false}
            placement="right"
            size="min(480px, 100vw)"
            destroyOnHidden
            styles={{ body: { padding: 0 } }}
          >
            <TeammateSkillsPanel
              key={primaryTeammateBranch.branch_id}
              branch={primaryTeammateBranch}
              client={client}
              onClose={() => setSkillsOpen(false)}
              onOpenFiles={
                onOpenSettings
                  ? () => {
                      setSkillsOpen(false);
                      onOpenSettings(primaryTeammateBranch.branch_id, 'files');
                    }
                  : undefined
              }
            />
          </Drawer>

          {sessionDetailsHydrated ? (
            <BranchSessionSections
              branch={primaryTeammateBranch}
              sessions={teammateSessions}
              userById={userById}
              currentUserId={currentUserId}
              selectedSessionId={selectedSessionId}
              onSessionClick={onSessionClick}
              onCreateSession={onCreateSession}
              onForkSession={onForkSession}
              onSpawnSession={onSpawnSession}
              onOpenSessionSettings={onOpenSessionSettings}
              mode="panel"
              fillAvailableHeight
              client={client}
            />
          ) : (
            <div style={{ paddingTop: 8 }}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Loading sessions…
                </Typography.Text>
                <Skeleton active paragraph={{ rows: 3 }} title={false} />
                <Button
                  size="small"
                  type="link"
                  onClick={hydrateDeferredDetails}
                  style={{ padding: 0 }}
                >
                  Show now
                </Button>
              </Space>
            </div>
          )}
        </div>
      );
    }

    // The branch is known but its repo hasn't loaded: not the empty state.
    if (primaryTeammateBranch) return boardLoadingSkeleton;

    if (primaryTeammateInaccessible) {
      if (teammateLookup.status === 'loading' || teammateLookup.status === 'found') {
        return boardLoadingSkeleton;
      }
      return (
        <div style={{ padding: 16 }}>
          {teammateLookup.status === 'failed' ? (
            <CompactNotice
              type="error"
              role="alert"
              message="Couldn't load this board's teammate."
              actions={[{ label: 'Try again', onClick: retryTeammateLookup }]}
              details={[{ label: 'Error', value: teammateLookup.error, code: true }]}
            />
          ) : (
            <CompactNotice
              type="neutral"
              role="status"
              message={
                teammateLookup.status === 'archived'
                  ? "This board's teammate is archived."
                  : "This board's teammate isn't available. It may have been deleted, or you may not have access."
              }
            />
          )}
        </div>
      );
    }

    return (
      <div style={{ padding: 16 }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Typography.Text type="secondary">
              This board doesn't have a primary teammate yet.
            </Typography.Text>
          }
          style={{ padding: '24px 0 16px' }}
        >
          {canCreateTeammate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={onCreateTeammate}>
              Create AI teammate
            </Button>
          )}
        </Empty>
        {canEditBoard && (!canCreateTeammate || teammateOptions.length > 0) && (
          <Space orientation="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Text strong>
              {canCreateTeammate ? 'Or assign an existing teammate' : 'Assign an existing teammate'}
            </Typography.Text>
            <Select
              showSearch
              aria-label="Select a teammate"
              placeholder="Select a teammate"
              value={selectedTeammateId}
              onChange={setSelectedTeammateId}
              options={teammateOptions}
              optionFilterProp="searchText"
              disabled={assigningTeammate || teammateOptions.length === 0}
              loading={!teammatesLoaded}
              style={{ width: '100%' }}
            />
            {teammateOptions.length === 0 && teammatesLoaded && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                No existing teammates are available to assign.
              </Typography.Text>
            )}
            <Button
              type={canCreateTeammate ? 'default' : 'primary'}
              onClick={handleAssignTeammate}
              loading={assigningTeammate}
              disabled={!selectedTeammateId || !board || !client}
            >
              Assign
            </Button>
          </Space>
        )}
      </div>
    );
  })();

  return (
    <div
      style={{
        height: '100%',
        background: token.colorBgContainer,
        borderRight: touch ? undefined : `1px solid ${token.colorBorderSecondary}`,
        overflow: 'hidden',
      }}
    >
      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as BoardTeammatePanelTab)}
        items={[
          ...(boardTab ? [{ key: 'board', label: 'Board', children: boardTab }] : []),
          {
            key: 'teammate',
            label: 'Teammate',
            children: <div style={{ height: '100%', overflow: 'auto' }}>{teammateContent}</div>,
          },
          {
            key: 'all-sessions',
            label: 'Sessions',
            children: board ? (
              <div style={{ height: '100%', overflow: 'auto' }}>
                {!boardReady ? (
                  boardLoading(boardFailed ? board.board_id : undefined)
                ) : sessionDetailsHydrated ? (
                  <BoardSessionList
                    board={board}
                    currentBoardId={board.board_id}
                    branchById={branchById}
                    repoById={repoById}
                    sessionsByBranch={sessionsByBranch}
                    onSessionClick={onSessionClick}
                  />
                ) : (
                  <div style={{ padding: 16 }}>
                    <Skeleton active paragraph={{ rows: 4 }} title={false} />
                  </div>
                )}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No board selected" />
            ),
          },
          {
            key: 'all-branches',
            label: 'Branches',
            children: board ? (
              <div style={{ height: '100%', overflow: 'auto' }}>
                {sessionDetailsHydrated ? (
                  <BoardBranchList
                    key={board.board_id}
                    board={board}
                    repoById={repoById}
                    client={client}
                  />
                ) : (
                  <div style={{ padding: 16 }}>
                    <Skeleton active paragraph={{ rows: 4 }} title={false} />
                  </div>
                )}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No board selected" />
            ),
          },
          {
            key: 'comments',
            label: (
              <span style={{ display: 'inline-flex', alignItems: 'flex-start' }}>
                Comments
                {/* In-flow (so the tab measures it and the scrolling list never clips it),
                    raised into the tab's top padding and tucked over the label's end. */}
                <Badge
                  count={unreadCommentsCount}
                  size="small"
                  styles={{
                    root: {
                      position: 'relative',
                      top: -token.paddingXS,
                      // An empty badge still has a root; do not subtract from
                      // the measured label width after the unread count clears.
                      // Touch tabs have room (no Branches tab), so the badge clears the label.
                      marginInlineStart:
                        unreadCommentsCount > 0 ? (touch ? token.marginXXS : -token.marginXS) : 0,
                    },
                    indicator: {
                      paddingInline: token.paddingXXS,
                      backgroundColor: hasUserMentions
                        ? token.colorError
                        : token.colorPrimaryBgHover,
                    },
                  }}
                />
              </span>
            ),
            children: board ? (
              <div style={{ height: '100%' }}>
                <CommentsPanel
                  client={client}
                  boardId={board.board_id}
                  comments={comments}
                  userById={userById}
                  currentUserId={currentUserId || 'unknown'}
                  boardObjects={boardObjects}
                  branchById={branchById}
                  onSendComment={(content) => onSendComment?.(content)}
                  onReplyComment={onReplyComment}
                  onResolveComment={onResolveComment}
                  onToggleReaction={onToggleReaction}
                  onDeleteComment={onDeleteComment}
                  hoveredCommentId={hoveredCommentId}
                  selectedCommentId={selectedCommentId}
                />
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No board selected" />
            ),
          },
        ].filter((item) => showBranchesTab || item.key !== 'all-branches')}
        rootClassName="agor-panel-tabs"
        tabBarGutter={token.marginSM}
        style={{ height: '100%' }}
        styles={{
          body: { height: '100%' },
          content: { height: '100%' },
          item: touch
            ? { fontSize: token.fontSize, padding: `${token.paddingSM}px 0` }
            : { fontSize: token.fontSizeSM, padding: `${token.paddingXS}px 0` },
        }}
        tabBarStyle={{ margin: 0 }}
        // Insets live in the extra slots, not tab-bar padding: rc-tabs measures the bar
        // minus its extras, so padding would hide overflow from its scroll/fade logic.
        tabBarExtraContent={{
          left: <div style={{ width: token.padding }} />,
          right: (
            <div style={{ paddingInlineEnd: token.paddingXXS }}>
              {onCollapse && (
                <Tooltip title="Collapse panel" placement="bottom">
                  <Button
                    type="text"
                    size="small"
                    aria-label="Collapse panel"
                    icon={<LeftOutlined style={{ fontSize: 11 }} />}
                    onClick={onCollapse}
                  />
                </Tooltip>
              )}
            </div>
          ),
        }}
      />
    </div>
  );
};

// Memoized: the inner App stabilizes every handler prop it passes (via
// useStableCallback), so React.memo bails out of re-renders driven by unrelated
// store patches and only re-renders when a value prop it draws actually changes.
export const BoardTeammatePanel = memo(BoardTeammatePanelComponent);

export default BoardTeammatePanel;
