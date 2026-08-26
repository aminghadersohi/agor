import type { ChatCollection, SessionID, UpdateUserInput, User } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Input, Select, Space, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectBranchById, selectSessionById } from '../../store/selectors';
import { useThemedMessage } from '../../utils/message';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { AdaptiveSettingsModal } from '../SettingsModal/AdaptiveSettingsModal';
import {
  createTeammateChatCollection,
  MAX_SESSIONS_PER_TEAMMATE_CHAT_COLLECTION,
  MAX_TEAMMATE_CHAT_COLLECTIONS,
  readTeammateChatPreferences,
  withTeammateChatPreferences,
} from './preferences';

const { Text } = Typography;

function makeCollectionId(): string {
  const random = new Uint8Array(12);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(random);
  } else {
    // Collection IDs identify entries inside one user's preferences; they are
    // not authorization tokens. Keep creation functional in restricted or
    // older browser contexts where Web Crypto is unavailable.
    for (let index = 0; index < random.length; index += 1) {
      random[index] = Math.floor(Math.random() * 256);
    }
  }
  const suffix = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `chat-${Date.now().toString(36)}-${suffix}`;
}

export interface TeammateChatCollectionsModalProps {
  open: boolean;
  currentUser: User | null | undefined;
  preselectedSessionId?: string;
  onClose: () => void;
  onUpdateUser?: (userId: string, updates: UpdateUserInput) => Promise<void>;
}

export function TeammateChatCollectionsModal({
  open,
  currentUser,
  preselectedSessionId,
  onClose,
  onUpdateUser,
}: TeammateChatCollectionsModalProps) {
  const { showError, showSuccess } = useThemedMessage();
  const sessionById = useAgorStore(selectSessionById);
  const branchById = useAgorStore(selectBranchById);
  const [collections, setCollections] = useState<ChatCollection[]>([]);
  const [saving, setSaving] = useState(false);

  const eligibleSessions = useMemo(
    () =>
      Array.from(sessionById.values())
        .flatMap((session) => {
          if (session.archived) return [];
          const branch = branchById.get(session.branch_id);
          if (!branch || branch.archived) return [];
          const teammate = getTeammateConfig(branch);
          return [
            {
              value: session.session_id,
              label: `${teammate?.emoji || '💬'} ${
                teammate?.displayName || branch.name
              } · ${getSessionDisplayTitle(session, { includeAgentFallback: true })}`,
              updatedAt: session.last_updated,
            },
          ];
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(({ value, label }) => ({ value, label })),
    [branchById, sessionById]
  );
  const storedPreferences = useMemo(
    () => readTeammateChatPreferences(currentUser?.preferences),
    [currentUser?.preferences]
  );
  const sessionOptions = useMemo(() => {
    const options = [...eligibleSessions];
    const known = new Set(options.map((option) => option.value));
    for (const sessionId of storedPreferences.collections.flatMap(
      (collection) => collection.session_ids
    )) {
      if (!known.has(sessionId)) {
        known.add(sessionId);
        options.push({ value: sessionId, label: 'Unavailable session' });
      }
    }
    return options;
  }, [eligibleSessions, storedPreferences.collections]);

  useEffect(() => {
    if (!open) return;
    const eligibleSessionIds = new Set(eligibleSessions.map((option) => option.value));
    const stored = storedPreferences.collections.map((collection) => ({ ...collection }));
    const requestedSessionId = preselectedSessionId as SessionID | undefined;
    const preselected =
      requestedSessionId && eligibleSessionIds.has(requestedSessionId)
        ? requestedSessionId
        : undefined;
    if (preselected && !stored.some((collection) => collection.session_ids.includes(preselected))) {
      if (stored.length > 0) {
        stored[0] = { ...stored[0], session_ids: [...stored[0].session_ids, preselected] };
      } else {
        stored.push(
          createTeammateChatCollection(makeCollectionId(), 'Pinned chats', [preselected])
        );
      }
    }
    setCollections(stored);
  }, [eligibleSessions, open, preselectedSessionId, storedPreferences.collections]);

  const addCollection = () => {
    if (collections.length >= MAX_TEAMMATE_CHAT_COLLECTIONS) return;
    setCollections((current) => [
      ...current,
      createTeammateChatCollection(makeCollectionId(), `Chat group ${current.length + 1}`),
    ]);
  };

  const save = async () => {
    if (!currentUser || !onUpdateUser) return;
    const invalid = collections.find((collection) => !collection.name.trim());
    if (invalid) {
      showError('Every chat collection needs a name.');
      return;
    }
    setSaving(true);
    try {
      await onUpdateUser(currentUser.user_id, {
        preferences: withTeammateChatPreferences(currentUser.preferences, { collections }),
      });
      showSuccess('Chat collections updated');
      onClose();
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to update chat collections');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdaptiveSettingsModal
      title={preselectedSessionId ? 'Pin session to Home' : 'Manage chat collections'}
      open={open}
      onCancel={onClose}
      onOk={save}
      okText="Save"
      confirmLoading={saving}
      okButtonProps={{ disabled: !currentUser || !onUpdateUser }}
      width={680}
      destroyOnHidden
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Text type="secondary">
          Group any sessions on Home, including conversations from AI teammates and gateway
          channels. Collections store references only; each conversation keeps its original history
          and permissions.
        </Text>

        {collections.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No chat collections yet">
            <Button type="primary" icon={<PlusOutlined />} onClick={addCollection}>
              Create collection
            </Button>
          </Empty>
        ) : (
          collections.map((collection) => (
            <Card
              key={collection.collection_id}
              size="small"
              title={
                <Input
                  aria-label="Collection name"
                  value={collection.name}
                  maxLength={60}
                  variant="borderless"
                  onChange={(event) => {
                    const name = event.target.value;
                    setCollections((current) =>
                      current.map((item) =>
                        item.collection_id === collection.collection_id ? { ...item, name } : item
                      )
                    );
                  }}
                />
              }
              extra={
                <Button
                  type="text"
                  danger
                  aria-label={`Delete ${collection.name}`}
                  icon={<DeleteOutlined />}
                  onClick={() =>
                    setCollections((current) =>
                      current.filter((item) => item.collection_id !== collection.collection_id)
                    )
                  }
                />
              }
              styles={{ body: { padding: 12 } }}
            >
              <Select
                mode="multiple"
                aria-label={`Sessions in ${collection.name}`}
                placeholder="Choose conversations"
                value={collection.session_ids}
                options={sessionOptions}
                maxCount={MAX_SESSIONS_PER_TEAMMATE_CHAT_COLLECTION}
                optionFilterProp="label"
                showSearch
                onChange={(sessionIds) =>
                  setCollections((current) =>
                    current.map((item) =>
                      item.collection_id === collection.collection_id
                        ? { ...item, session_ids: sessionIds as SessionID[] }
                        : item
                    )
                  )
                }
                style={{ width: '100%' }}
              />
            </Card>
          ))
        )}

        {collections.length > 0 && (
          <Button
            block
            icon={<PlusOutlined />}
            disabled={collections.length >= MAX_TEAMMATE_CHAT_COLLECTIONS}
            onClick={addCollection}
          >
            Add collection
          </Button>
        )}
      </Space>
    </AdaptiveSettingsModal>
  );
}
