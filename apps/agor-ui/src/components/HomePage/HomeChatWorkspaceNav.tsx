import { getTeammateConfig } from '@agor-live/client';
import {
  ArrowLeftOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import type { TreeDataNode } from 'antd';
import { Button, Empty, Flex, Tree, Typography, theme } from 'antd';
import type { Key } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectBranchById, selectSessionById, selectUserById } from '../../store/selectors';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { readTeammateChatPreferences } from '../TeammateChatCollections/preferences';
import { StatusDot } from './StatusDot';

const { Text, Title } = Typography;

export interface HomeChatWorkspaceNavProps {
  currentUserId?: string;
  activeSessionId?: string | null;
  onSessionClick: (sessionId: string) => void;
  onManage: () => void;
  onExit: () => void;
}

export function HomeChatWorkspaceNav({
  currentUserId,
  activeSessionId,
  onSessionClick,
  onManage,
  onExit,
}: HomeChatWorkspaceNavProps) {
  const { token } = theme.useToken();
  const userById = useAgorStore(selectUserById);
  const sessionById = useAgorStore(selectSessionById);
  const branchById = useAgorStore(selectBranchById);
  const currentUserPreferences = currentUserId
    ? userById.get(currentUserId)?.preferences
    : undefined;
  const preferences = useMemo(
    () => readTeammateChatPreferences(currentUserPreferences),
    [currentUserPreferences]
  );
  const [expandedKeys, setExpandedKeys] = useState<Key[]>([]);
  const initializedExpansion = useRef(false);

  const treeData = useMemo<TreeDataNode[]>(
    () =>
      preferences.collections.map((collection) => {
        const sessionsByBranch = new Map<string, TreeDataNode[]>();
        for (const sessionId of collection.session_ids) {
          const session = sessionById.get(sessionId);
          if (!session || session.archived) continue;
          const branch = branchById.get(session.branch_id);
          if (!branch || branch.archived) continue;
          const children = sessionsByBranch.get(branch.branch_id) ?? [];
          children.push({
            key: `session:${collection.collection_id}:${session.session_id}`,
            title: (
              <span
                style={{
                  minWidth: 0,
                  display: 'grid',
                  gridTemplateColumns: 'auto minmax(0, 1fr)',
                  alignItems: 'center',
                  gap: 7,
                }}
              >
                <StatusDot status={session.status} />
                <Text ellipsis style={{ display: 'block', minWidth: 0, fontSize: 13 }}>
                  {getSessionDisplayTitle(session, { includeAgentFallback: true })}
                </Text>
              </span>
            ),
            isLeaf: true,
          });
          sessionsByBranch.set(branch.branch_id, children);
        }

        return {
          key: `collection:${collection.collection_id}`,
          icon: <FolderOpenOutlined />,
          title: <Text strong>{collection.name}</Text>,
          selectable: false,
          children: Array.from(sessionsByBranch.entries()).map(([branchId, sessions]) => {
            const branch = branchById.get(branchId)!;
            const teammate = getTeammateConfig(branch);
            return {
              key: `branch:${collection.collection_id}:${branchId}`,
              title: (
                <Text ellipsis style={{ fontSize: 12 }}>
                  {teammate?.emoji ? `${teammate.emoji} ` : ''}
                  {teammate?.displayName || branch.name}
                </Text>
              ),
              selectable: false,
              children: sessions,
            };
          }),
        };
      }),
    [branchById, preferences.collections, sessionById]
  );
  const initiallyExpandedKeys = useMemo(
    () =>
      treeData.flatMap((collection) => [
        collection.key,
        ...(collection.children ?? []).map((branch) => branch.key),
      ]),
    [treeData]
  );
  useEffect(() => {
    if (treeData.length === 0) {
      initializedExpansion.current = false;
      setExpandedKeys([]);
    } else if (!initializedExpansion.current) {
      initializedExpansion.current = true;
      setExpandedKeys(initiallyExpandedKeys);
    }
  }, [initiallyExpandedKeys, treeData.length]);
  const selectedKeys = activeSessionId
    ? treeData.flatMap((collection) =>
        (collection.children ?? []).flatMap((branch) =>
          (branch.children ?? [])
            .filter((session) => String(session.key).endsWith(`:${activeSessionId}`))
            .map((session) => session.key)
        )
      )
    : [];

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: token.colorBgContainer,
        borderRight: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Flex vertical gap={3} style={{ padding: '16px 16px 12px' }}>
        <Button
          type="text"
          size="small"
          icon={<ArrowLeftOutlined />}
          onClick={onExit}
          style={{ alignSelf: 'flex-start', marginLeft: -8 }}
        >
          Home
        </Button>
        <Flex justify="space-between" align="center" gap={8}>
          <div style={{ minWidth: 0 }}>
            <Title level={5} style={{ margin: 0 }}>
              Chat workspace
            </Title>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Pinned sessions
            </Text>
          </div>
          <Button
            type="text"
            aria-label="Manage chat collections"
            icon={<SettingOutlined />}
            onClick={onManage}
          />
        </Flex>
      </Flex>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 8px 16px' }}>
        {treeData.length > 0 ? (
          <Tree
            blockNode
            showIcon
            showLine={{ showLeafIcon: false }}
            treeData={treeData}
            expandedKeys={expandedKeys}
            onExpand={setExpandedKeys}
            selectedKeys={selectedKeys}
            onSelect={(keys) => {
              const key = String(keys[0] ?? '');
              const sessionId = key.startsWith('session:') ? key.split(':').at(-1) : undefined;
              if (sessionId) onSessionClick(sessionId);
            }}
            style={{ background: 'transparent' }}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Pin sessions to build your chat workspace."
            style={{ marginTop: 32 }}
          >
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={onManage}>
              Create collection
            </Button>
          </Empty>
        )}
      </div>
    </div>
  );
}
