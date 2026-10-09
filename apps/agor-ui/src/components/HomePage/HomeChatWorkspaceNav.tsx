import type { Branch, Session, User } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import {
  AimOutlined,
  ArrowLeftOutlined,
  CheckOutlined,
  DownOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  RightOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Button, Flex, Tooltip, Typography, theme } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_BACKGROUNDS } from '../../constants/ui';
import { useAgorStore } from '../../store/agorStore';
import { selectBranchById } from '../../store/selectors';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { isDarkTheme } from '../../utils/theme';
import { formatRelativeTimeSafe } from '../../utils/time';
import { BoardTile } from '../BoardTile';
import { SessionRowLogo, SessionStatusMark } from '../SessionRow';
import {
  useChatCollections,
  usePinnedCollections,
} from '../TeammateChatCollections/useChatCollections';
import { TeammateIdentityAvatar } from '../TeammateIdentityAvatar';
import { HOME_ROW_LEAD, HOME_ROW_TITLE_WEIGHT } from './homeLayout';

/** Teammate avatar or board tile beside each branch in the tree. */
const IDENTITY_SIZE = 24;

interface ChatTreeBranch {
  key: string;
  branch: Branch;
  sessions: Session[];
}

interface ChatTreeCollection {
  key: string;
  collectionId: string;
  name: string;
  branches: ChatTreeBranch[];
  sessionCount: number;
}

export interface HomeChatWorkspaceNavProps {
  currentUser?: Pick<User, 'user_id' | 'preferences'> | null;
  activeSessionId?: string | null;
  onSessionClick: (sessionId: string) => void;
  /** Opens the collections manager, focused on a session when one is given. */
  onManage: (sessionId?: string) => void;
  onExit: () => void;
  onShowOnBoard: (sessionId: string) => void;
}

/**
 * The chat workspace's left rail: collection → branch or teammate → pinned session, beside
 * the open conversation. Only pinned sessions appear; finding more happens in Manage.
 */
export function HomeChatWorkspaceNav({
  currentUser,
  activeSessionId,
  onSessionClick,
  onManage,
  onExit,
  onShowOnBoard,
}: HomeChatWorkspaceNavProps) {
  const { token } = theme.useToken();
  const branchById = useAgorStore(selectBranchById);
  const { collections } = useChatCollections(currentUser);
  const pinned = usePinnedCollections(collections);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const initializedExpansion = useRef(false);

  const tree = useMemo<ChatTreeCollection[]>(
    () =>
      pinned.map(({ collection, sessions }) => {
        const sessionsByBranch = new Map<string, Session[]>();
        for (const session of sessions) {
          const list = sessionsByBranch.get(session.branch_id) ?? [];
          list.push(session);
          sessionsByBranch.set(session.branch_id, list);
        }
        return {
          key: `collection:${collection.collection_id}`,
          collectionId: collection.collection_id,
          name: collection.name,
          sessionCount: sessions.length,
          branches: [...sessionsByBranch].flatMap(([branchId, branchSessions]) => {
            const branch = branchById.get(branchId);
            return branch
              ? [
                  {
                    key: `branch:${collection.collection_id}:${branchId}`,
                    branch,
                    sessions: branchSessions,
                  },
                ]
              : [];
          }),
        };
      }),
    [branchById, pinned]
  );
  const allKeys = useMemo(
    () => tree.flatMap((collection) => [collection.key, ...collection.branches.map((b) => b.key)]),
    [tree]
  );
  // Everything starts open the first time there is something to show.
  useEffect(() => {
    if (tree.length === 0) {
      initializedExpansion.current = false;
      setExpandedKeys(new Set());
    } else if (!initializedExpansion.current) {
      initializedExpansion.current = true;
      setExpandedKeys(new Set(allKeys));
    }
  }, [allKeys, tree.length]);

  const toggleExpanded = (key: string) =>
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const disclosureIcon = (expanded: boolean) => {
    const Icon = expanded ? DownOutlined : RightOutlined;
    return <Icon style={{ fontSize: token.fontSizeSM, color: token.colorTextTertiary }} />;
  };
  // Disclosure rows share one grid: chevron, identity, label, count.
  const rowGrid = `${token.fontSizeSM}px ${IDENTITY_SIZE}px minmax(0, 1fr) auto`;
  const rowButton: React.CSSProperties = {
    width: '100%',
    minHeight: token.controlHeight,
    display: 'grid',
    gridTemplateColumns: rowGrid,
    alignItems: 'center',
    gap: token.marginXS,
    padding: `${token.paddingXXS}px ${token.paddingXS}px`,
    border: 0,
    borderRadius: token.borderRadius,
    background: 'transparent',
    color: token.colorText,
    font: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
  };

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: DEFAULT_BACKGROUNDS[isDarkTheme(token) ? 'dark' : 'light'],
        borderRight: `${token.lineWidth}px ${token.lineType} ${token.colorSplit}`,
      }}
    >
      <Flex
        vertical
        gap={token.marginXXS}
        style={{ padding: `${token.padding}px ${token.padding}px ${token.paddingSM}px` }}
      >
        <Button
          type="text"
          size="small"
          icon={<ArrowLeftOutlined />}
          onClick={onExit}
          style={{ alignSelf: 'flex-start', marginInlineStart: -token.paddingXS }}
        >
          Home
        </Button>
        <Flex justify="space-between" align="center" gap={token.marginXS}>
          <div style={{ minWidth: 0 }}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              Chat workspace
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Pinned sessions
            </Typography.Text>
          </div>
          <Flex gap={token.marginXXS}>
            {activeSessionId && (
              <Tooltip title="Show on board">
                <Button
                  type="text"
                  aria-label="Show active session on board"
                  icon={<AimOutlined />}
                  onClick={() => onShowOnBoard(activeSessionId)}
                />
              </Tooltip>
            )}
            <Tooltip title="Manage chat collections">
              <Button
                type="text"
                aria-label="Manage chat collections"
                icon={<SettingOutlined />}
                onClick={() => onManage()}
              />
            </Tooltip>
          </Flex>
        </Flex>
      </Flex>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: `${token.paddingXXS}px ${token.paddingXS}px ${token.padding}px`,
        }}
      >
        {tree.length > 0 ? (
          <nav aria-label="Chat collections">
            <Flex vertical gap={token.marginXS}>
              {tree.map((collection) => {
                const collectionExpanded = expandedKeys.has(collection.key);
                return (
                  <section key={collection.collectionId} aria-label={collection.name}>
                    <button
                      type="button"
                      className="agor-home-pressable"
                      aria-expanded={collectionExpanded}
                      onClick={() => toggleExpanded(collection.key)}
                      style={{ ...rowButton, background: token.colorFillQuaternary }}
                    >
                      {disclosureIcon(collectionExpanded)}
                      <Flex align="center" justify="center" aria-hidden>
                        <FolderOpenOutlined style={{ color: token.colorTextSecondary }} />
                      </Flex>
                      <Typography.Text strong ellipsis style={{ minWidth: 0 }}>
                        {collection.name}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                        {collection.sessionCount}
                      </Typography.Text>
                    </button>

                    {collectionExpanded && (
                      <Flex
                        vertical
                        gap={token.marginXXS}
                        style={{
                          paddingBlockStart: token.paddingXXS,
                          paddingInlineStart: token.paddingXS,
                        }}
                      >
                        {collection.branches.map(({ key, branch, sessions }) => {
                          const branchExpanded = expandedKeys.has(key);
                          const teammate = getTeammateConfig(branch);
                          const branchLabel = teammate?.displayName || branch.name;
                          return (
                            <div key={key}>
                              <button
                                type="button"
                                className="agor-home-pressable"
                                aria-expanded={branchExpanded}
                                aria-label={`${branchExpanded ? 'Collapse' : 'Expand'} sessions for ${branchLabel}`}
                                onClick={() => toggleExpanded(key)}
                                style={rowButton}
                              >
                                {disclosureIcon(branchExpanded)}
                                {teammate ? (
                                  <TeammateIdentityAvatar
                                    aria-hidden
                                    branch={branch}
                                    size={IDENTITY_SIZE}
                                  />
                                ) : (
                                  <BoardTile size={IDENTITY_SIZE} />
                                )}
                                <Typography.Text ellipsis style={{ minWidth: 0 }}>
                                  {branchLabel}
                                </Typography.Text>
                                <Typography.Text
                                  type="secondary"
                                  style={{ fontSize: token.fontSizeSM }}
                                >
                                  {sessions.length}
                                </Typography.Text>
                              </button>

                              {branchExpanded && (
                                <Flex
                                  vertical
                                  gap={token.marginXXS}
                                  style={{
                                    paddingBlock: token.paddingXXS,
                                    paddingInlineStart: token.fontSizeSM + token.marginXS,
                                  }}
                                >
                                  {sessions.map((session) => (
                                    <ChatTreeSession
                                      key={session.session_id}
                                      session={session}
                                      active={session.session_id === activeSessionId}
                                      onOpen={onSessionClick}
                                      onManage={onManage}
                                    />
                                  ))}
                                </Flex>
                              )}
                            </div>
                          );
                        })}
                      </Flex>
                    )}
                  </section>
                );
              })}
            </Flex>
          </nav>
        ) : (
          <Flex
            vertical
            align="center"
            gap={token.marginSM}
            style={{ marginTop: token.marginXL, textAlign: 'center' }}
          >
            <Typography.Text type="secondary">
              Pin sessions to build your chat workspace.
            </Typography.Text>
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => onManage()}>
              Create collection
            </Button>
          </Flex>
        )}
      </div>
    </div>
  );
}

const ChatTreeSession: React.FC<{
  session: Session;
  active: boolean;
  onOpen: (sessionId: string) => void;
  onManage: (sessionId: string) => void;
}> = ({ session, active, onOpen, onManage }) => {
  const { token } = theme.useToken();
  const title = getSessionDisplayTitle(session, { includeAgentFallback: true });
  return (
    <Flex
      align="center"
      gap={token.marginXXS}
      className={active ? undefined : 'agor-home-pressable'}
      style={{
        borderRadius: token.borderRadius,
        paddingInline: `${token.paddingXS}px ${token.paddingXXS}px`,
        background: active ? token.colorPrimaryBg : undefined,
        color: active ? token.colorPrimaryText : token.colorText,
      }}
    >
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={() => onOpen(session.session_id)}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: token.controlHeight,
          display: 'grid',
          gridTemplateColumns: `${HOME_ROW_LEAD}px minmax(0, 1fr) auto auto`,
          alignItems: 'center',
          gap: token.marginXS,
          padding: 0,
          border: 0,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <Flex align="center" justify="center">
          <SessionRowLogo tool={session.agentic_tool} />
        </Flex>
        <Typography.Text
          ellipsis
          style={{
            minWidth: 0,
            color: 'inherit',
            fontWeight: active ? token.fontWeightStrong : HOME_ROW_TITLE_WEIGHT,
          }}
        >
          {title}
        </Typography.Text>
        <Typography.Text
          type="secondary"
          style={{ fontSize: token.fontSizeSM, whiteSpace: 'nowrap' }}
        >
          {formatRelativeTimeSafe(session.last_updated)}
        </Typography.Text>
        <SessionStatusMark session={session} />
      </button>
      <Tooltip title="Added — manage or remove">
        <Button
          type="text"
          size="small"
          aria-label={`Manage ${title} in collection`}
          icon={<CheckOutlined />}
          onClick={() => onManage(session.session_id)}
          style={{ color: token.colorPrimary }}
        />
      </Tooltip>
    </Flex>
  );
};
