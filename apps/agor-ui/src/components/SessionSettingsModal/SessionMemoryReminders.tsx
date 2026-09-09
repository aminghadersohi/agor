import type { AgorClient, Paginated, SessionMemory, SessionReminder } from '@agor-live/client';
import {
  BellOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Empty,
  Flex,
  Form,
  Input,
  List,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import React from 'react';

type Props = { client: AgorClient; sessionId: string; sessionArchived: boolean };

function pageData<T>(result: T[] | Paginated<T>): T[] {
  return Array.isArray(result) ? result : result.data;
}

function localInputToUtc(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function dueLabel(reminder: SessionReminder): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: reminder.display_timezone,
    }).format(new Date(reminder.due_at));
  } catch {
    return new Date(reminder.due_at).toLocaleString();
  }
}

/** Compact Session-owned UI. Content never appears on board cards or analytics. */
export const SessionMemoryReminders: React.FC<Props> = ({ client, sessionId, sessionArchived }) => {
  const [tab, setTab] = React.useState<'Memory' | 'Reminders'>('Memory');
  const [memories, setMemories] = React.useState<SessionMemory[]>([]);
  const [reminders, setReminders] = React.useState<SessionReminder[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [query, setQuery] = React.useState('');
  const [memoryText, setMemoryText] = React.useState('');
  const [reminderText, setReminderText] = React.useState('');
  const [dueLocal, setDueLocal] = React.useState('');
  const [editingMemory, setEditingMemory] = React.useState<SessionMemory>();
  const [editingReminder, setEditingReminder] = React.useState<SessionReminder>();

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [memoryResult, reminderResult] = await Promise.all([
        client.service('session-memories').find({
          query: {
            session_id: sessionId,
            archived: false,
            search: query.trim() || undefined,
            $limit: 25,
          },
        }),
        client.service('session-reminders').find({
          query: { session_id: sessionId, $limit: 50 },
        }),
      ]);
      setMemories(pageData(memoryResult));
      setReminders(pageData(reminderResult));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Memory and reminders could not be loaded.'
      );
    } finally {
      setLoading(false);
    }
  }, [client, query, sessionId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    const memoryService = client.service('session-memories');
    const reminderService = client.service('session-reminders');
    const converge = (row: { session_id?: string }) => {
      if (row.session_id === sessionId) void load();
    };
    memoryService.on('created', converge);
    memoryService.on('patched', converge);
    reminderService.on('created', converge);
    reminderService.on('patched', converge);
    return () => {
      memoryService.off('created', converge);
      memoryService.off('patched', converge);
      reminderService.off('created', converge);
      reminderService.off('patched', converge);
    };
  }, [client, load, sessionId]);

  const failOrReload = async (cause: unknown) => {
    setError(cause instanceof Error ? cause.message : 'The change failed.');
    await load();
  };

  const createMemory = async () => {
    if (!memoryText.trim()) return;
    try {
      await client.service('session-memories').create({
        session_id: sessionId,
        text: memoryText,
      });
      setMemoryText('');
      await load();
    } catch (cause) {
      await failOrReload(cause);
    }
  };

  const saveMemory = async () => {
    if (!editingMemory) return;
    try {
      await client.service('session-memories').patch(editingMemory.memory_id, {
        session_id: sessionId,
        expected_revision: editingMemory.revision,
        title: editingMemory.title,
        text: editingMemory.text,
        tags: editingMemory.tags,
      });
      setEditingMemory(undefined);
      await load();
    } catch (cause) {
      setEditingMemory(undefined);
      await failOrReload(cause);
    }
  };

  const archiveMemory = async (memory: SessionMemory) => {
    try {
      await client.service('session-memories').patch(memory.memory_id, {
        session_id: sessionId,
        expected_revision: memory.revision,
        archived: true,
      });
      await load();
    } catch (cause) {
      await failOrReload(cause);
    }
  };

  const createReminder = async () => {
    const dueAt = localInputToUtc(dueLocal);
    if (!reminderText.trim() || !dueAt) return;
    try {
      await client.service('session-reminders').create({
        session_id: sessionId,
        text: reminderText,
        due_at: dueAt,
        display_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      });
      setReminderText('');
      setDueLocal('');
      await load();
    } catch (cause) {
      await failOrReload(cause);
    }
  };

  const saveReminder = async () => {
    if (!editingReminder) return;
    try {
      await client.service('session-reminders').patch(editingReminder.reminder_id, {
        session_id: sessionId,
        expected_revision: editingReminder.revision,
        text: editingReminder.text,
        due_at: editingReminder.due_at,
        display_timezone: editingReminder.display_timezone,
      });
      setEditingReminder(undefined);
      await load();
    } catch (cause) {
      setEditingReminder(undefined);
      await failOrReload(cause);
    }
  };

  const cancelReminder = async (reminder: SessionReminder) => {
    try {
      await client.service('session-reminders').patch(reminder.reminder_id, {
        session_id: sessionId,
        expected_revision: reminder.revision,
        cancel: true,
      });
      await load();
    } catch (cause) {
      await failOrReload(cause);
    }
  };

  return (
    <section aria-label="Session memory and reminders">
      <Typography.Paragraph type="secondary" style={{ marginBlockEnd: 12 }}>
        Private working memory belongs only to this conversation. Shared Knowledge requires an
        explicit, authorized promotion. Don&apos;t store secrets.
      </Typography.Paragraph>
      <Alert
        type="info"
        showIcon
        style={{ marginBlockEnd: 12 }}
        title="Reminders resume this same Session through its normal queue and depend on its branch and worktree remaining executable."
      />
      {sessionArchived && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBlockEnd: 12 }}
          title="This Session is archived. Existing items remain inspectable; restore it before scheduling a reminder or using agent self-mutation tools."
        />
      )}
      <Segmented
        block
        value={tab}
        onChange={(value) => setTab(value as 'Memory' | 'Reminders')}
        options={['Memory', 'Reminders']}
        aria-label="Choose memory or reminders"
      />
      {error && (
        <Alert
          type="error"
          closable
          onClose={() => setError(undefined)}
          title={error}
          style={{ marginBlock: 12 }}
        />
      )}
      {loading ? (
        <Flex justify="center" style={{ padding: 24 }}>
          <Spin aria-label="Loading Session memory and reminders" />
        </Flex>
      ) : tab === 'Memory' ? (
        <Space orientation="vertical" size="middle" style={{ width: '100%', marginBlockStart: 12 }}>
          <Input.Search
            allowClear
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onSearch={() => void load()}
            enterButton={<SearchOutlined aria-label="Search memories" />}
            placeholder="Search memory"
            aria-label="Search this Session's memory"
          />
          <Input.TextArea
            value={memoryText}
            onChange={(event) => setMemoryText(event.target.value)}
            autoSize={{ minRows: 2, maxRows: 5 }}
            maxLength={8192}
            showCount
            placeholder="Remember a fact or decision…"
            aria-label="New Session memory"
          />
          <Button
            icon={<PlusOutlined />}
            onClick={() => void createMemory()}
            disabled={!memoryText.trim()}
          >
            Remember
          </Button>
          {memories.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No matching memories" />
          ) : (
            <List
              size="small"
              dataSource={memories}
              renderItem={(memory) => (
                <List.Item
                  actions={[
                    <Button
                      key="edit"
                      type="text"
                      icon={<EditOutlined />}
                      aria-label="Edit memory"
                      onClick={() => setEditingMemory({ ...memory })}
                    />,
                    <Button
                      key="archive"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label="Archive memory"
                      onClick={() => void archiveMemory(memory)}
                    />,
                  ]}
                >
                  <List.Item.Meta
                    title={memory.title || 'Memory'}
                    description={
                      <>
                        <Typography.Paragraph ellipsis={{ rows: 3 }} style={{ marginBottom: 4 }}>
                          {memory.text}
                        </Typography.Paragraph>
                        {memory.tags.map((value) => (
                          <Tag key={value}>{value}</Tag>
                        ))}
                      </>
                    }
                  />
                </List.Item>
              )}
            />
          )}
          {editingMemory && (
            <Form layout="vertical" aria-label="Edit Session memory">
              <Form.Item label="Title">
                <Input
                  value={editingMemory.title}
                  onChange={(event) =>
                    setEditingMemory({ ...editingMemory, title: event.target.value })
                  }
                />
              </Form.Item>
              <Form.Item label="Memory">
                <Input.TextArea
                  autoFocus
                  value={editingMemory.text}
                  onChange={(event) =>
                    setEditingMemory({ ...editingMemory, text: event.target.value })
                  }
                />
              </Form.Item>
              <Space>
                <Button type="primary" onClick={() => void saveMemory()}>
                  Save memory
                </Button>
                <Button onClick={() => setEditingMemory(undefined)}>Cancel</Button>
              </Space>
            </Form>
          )}
        </Space>
      ) : (
        <Space orientation="vertical" size="middle" style={{ width: '100%', marginBlockStart: 12 }}>
          <Input.TextArea
            value={reminderText}
            onChange={(event) => setReminderText(event.target.value)}
            autoSize={{ minRows: 2, maxRows: 5 }}
            maxLength={4096}
            showCount
            placeholder="What should this Session resume to do?"
            aria-label="Reminder prompt"
            disabled={sessionArchived}
          />
          <Input
            type="datetime-local"
            value={dueLocal}
            onChange={(event) => setDueLocal(event.target.value)}
            aria-label="Reminder due date and time"
            disabled={sessionArchived}
          />
          <Button
            icon={<BellOutlined />}
            onClick={() => void createReminder()}
            disabled={sessionArchived || !reminderText.trim() || !dueLocal}
          >
            Schedule one-shot reminder
          </Button>
          {reminders.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No reminders" />
          ) : (
            <List
              size="small"
              dataSource={reminders}
              renderItem={(reminder) => (
                <List.Item
                  actions={
                    reminder.status === 'scheduled'
                      ? [
                          <Button
                            key="edit"
                            type="text"
                            icon={<EditOutlined />}
                            aria-label="Edit reminder"
                            onClick={() => setEditingReminder({ ...reminder })}
                          />,
                          <Button
                            key="cancel"
                            type="text"
                            danger
                            aria-label="Cancel reminder"
                            onClick={() => void cancelReminder(reminder)}
                          >
                            Cancel
                          </Button>,
                        ]
                      : undefined
                  }
                >
                  <List.Item.Meta
                    title={
                      <Space wrap>
                        <Tag>{reminder.status}</Tag>
                        <span>{dueLabel(reminder)}</span>
                      </Space>
                    }
                    description={
                      <Typography.Paragraph ellipsis={{ rows: 3 }} style={{ marginBottom: 0 }}>
                        {reminder.text}
                      </Typography.Paragraph>
                    }
                  />
                </List.Item>
              )}
            />
          )}
          {editingReminder && (
            <Form layout="vertical" aria-label="Edit Session reminder">
              <Form.Item label="Reminder">
                <Input.TextArea
                  autoFocus
                  value={editingReminder.text}
                  onChange={(event) =>
                    setEditingReminder({ ...editingReminder, text: event.target.value })
                  }
                />
              </Form.Item>
              <Form.Item label="Due at (UTC ISO 8601)">
                <Input
                  value={editingReminder.due_at}
                  onChange={(event) =>
                    setEditingReminder({ ...editingReminder, due_at: event.target.value })
                  }
                />
              </Form.Item>
              <Space>
                <Button type="primary" onClick={() => void saveReminder()}>
                  Save reminder
                </Button>
                <Button onClick={() => setEditingReminder(undefined)}>Cancel</Button>
              </Space>
            </Form>
          )}
        </Space>
      )}
    </section>
  );
};
