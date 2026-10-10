import type { User } from '@agor-live/client';
import { FolderOpenOutlined } from '@ant-design/icons';
import { Flex, Typography, theme } from 'antd';
import { memo, useState } from 'react';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import {
  useChatCollections,
  usePinnedCollections,
} from '../TeammateChatCollections/useChatCollections';
import { HomeList, HomeSessionRow } from './HomeRow';
import { HomeCard, HomeLink, HomeSection, HomeShowMore, useHomeCompact } from './HomeSection';
import { HOME_ROW_LEAD, homeDivider, homeGroupIndent } from './homeLayout';

/** Rows a collection shows before its "show more". */
export const CHAT_COLLECTION_PREVIEW = 5;

interface HomeTeammateChatsSectionProps {
  currentUser?: Pick<User, 'user_id' | 'preferences'> | null;
  /** Opens a pinned conversation (the chat workspace on desktop). */
  onOpenSession: (sessionId: string) => void;
  /** Opens the collections manager. */
  onManage: () => void;
}

/** The person's own groupings of sessions: references only, titles resolve live. */
export const HomeTeammateChatsSection = memo(function HomeTeammateChatsSection({
  currentUser,
  onOpenSession,
  onManage,
}: HomeTeammateChatsSectionProps) {
  const { token } = theme.useToken();
  const compact = useHomeCompact();
  const { collections } = useChatCollections(currentUser);
  const groups = usePinnedCollections(collections);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (collectionId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(collectionId)) next.add(collectionId);
      return next;
    });

  // Phones keep Home short: the invitation lives on desktop and in session headers.
  if (groups.length === 0 && compact) return null;
  return (
    <HomeSection
      id="chats"
      title="Chat collections"
      info={
        'Your own groups of sessions, from any teammate, branch or channel.\nCollections link to sessions; they never copy them.'
      }
      extra={groups.length > 0 && <HomeLink onClick={onManage}>Manage</HomeLink>}
    >
      <HomeCard padded={groups.length === 0}>
        {groups.length === 0 ? (
          <Flex vertical align="flex-start" gap={token.marginXXS}>
            <Typography.Text type="secondary">
              Pin the conversations you use most and group them for quick access.
            </Typography.Text>
            <HomeLink onClick={onManage} style={{ paddingInline: 0 }}>
              Create a collection
            </HomeLink>
          </Flex>
        ) : (
          groups.map(({ collection, sessions }, index) => {
            const open = expanded.has(collection.collection_id);
            const shown = open ? sessions : sessions.slice(0, CHAT_COLLECTION_PREVIEW);
            return (
              <section
                key={collection.collection_id}
                aria-label={collection.name}
                style={index ? { borderTop: homeDivider(token) } : undefined}
              >
                <div
                  style={{
                    background: token.colorFillQuaternary,
                    borderBottom: homeDivider(token),
                  }}
                >
                  <Flex
                    align="center"
                    gap={token.marginXS}
                    style={{
                      minHeight: compact ? MOBILE_TOUCH_TARGET : undefined,
                      padding: `${token.paddingXS}px ${token.paddingSM}px`,
                    }}
                  >
                    <Flex
                      align="center"
                      justify="center"
                      style={{ width: HOME_ROW_LEAD, flex: '0 0 auto' }}
                    >
                      <FolderOpenOutlined style={{ color: token.colorTextSecondary }} />
                    </Flex>
                    <Typography.Text strong ellipsis style={{ flex: 1, minWidth: 0 }}>
                      {collection.name}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                      {sessions.length}
                    </Typography.Text>
                  </Flex>
                </div>
                {sessions.length === 0 ? (
                  <Typography.Text
                    type="secondary"
                    style={{
                      display: 'block',
                      padding: `${token.paddingXS}px ${token.paddingSM}px`,
                      paddingInlineStart: token.paddingSM + homeGroupIndent(token),
                      fontSize: token.fontSizeSM,
                    }}
                  >
                    No available sessions
                  </Typography.Text>
                ) : (
                  <HomeList
                    items={shown}
                    itemKey={(session) => session.session_id}
                    renderItem={(session) => (
                      <HomeSessionRow session={session} narrow onOpen={onOpenSession} />
                    )}
                  />
                )}
                {sessions.length > CHAT_COLLECTION_PREVIEW && (
                  <HomeShowMore
                    label={
                      open ? 'Show less' : `Show ${sessions.length - CHAT_COLLECTION_PREVIEW} more`
                    }
                    expanded={open}
                    onClick={() => toggle(collection.collection_id)}
                  />
                )}
              </section>
            );
          })
        )}
      </HomeCard>
    </HomeSection>
  );
});
