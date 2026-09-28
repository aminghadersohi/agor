import type {
  AgorClient,
  BoardID,
  Paginated,
  ZoneWorkflowAdvance,
  ZoneWorkflowAdvancedEntity,
  ZoneWorkflowPromptOutcome,
  ZoneWorkflowTransition,
} from '@agor-live/client';
import { Alert, Button, Flex, List, Modal, Tag, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAbsoluteTime, formatRelativeTime } from '../../../utils/time';

export const ADVANCE_HISTORY_PAGE_SIZE = 20;

/** Status is spelled out in text; the Tag color only reinforces it. */
const OUTCOME_LABELS: Record<
  ZoneWorkflowPromptOutcome,
  { label: string; color?: 'success' | 'warning' | 'error' }
> = {
  not_requested: { label: 'Moved only' },
  not_applicable: { label: 'No branch to prompt' },
  triggered: { label: 'Prompt started', color: 'success' },
  target_has_no_trigger: { label: 'Target has no trigger', color: 'warning' },
  target_requires_picker: { label: 'Needs manual session choice', color: 'warning' },
  failed: { label: 'Prompt failed', color: 'error' },
};

interface Props {
  open: boolean;
  client: AgorClient | null;
  boardId: BoardID;
  transition: ZoneWorkflowTransition;
  describeEntity: (entity: ZoneWorkflowAdvancedEntity) => string;
  describeUser: (userId: string) => string;
  onClose: () => void;
  afterClose?: () => void;
}

/**
 * Read-only advance audit for one workflow transition, newest first. Reading
 * needs only board view (the service authorizes it), so unlike Advance/Edit/
 * Delete the History action is not gated on edit rights.
 */
export function ZoneWorkflowAdvanceHistoryModal({
  open,
  client,
  boardId,
  transition,
  describeEntity,
  describeUser,
  onClose,
  afterClose,
}: Props) {
  const [rows, setRows] = useState<ZoneWorkflowAdvance[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transitionId = transition.transition_id;
  // Ids already shown, so a live event racing the first page is not counted twice.
  const shownIds = useRef(new Set<string>());
  useEffect(() => {
    shownIds.current = new Set(rows.map((row) => row.advance_id));
  }, [rows]);

  const loadPage = useCallback(
    async (skip: number) => {
      if (!client) return;
      setLoading(true);
      setError(null);
      try {
        const page = (await client.service('zone-workflow-advances').find({
          query: {
            board_id: boardId,
            transition_id: transitionId,
            $limit: ADVANCE_HISTORY_PAGE_SIZE,
            $skip: skip,
          },
        })) as Paginated<ZoneWorkflowAdvance>;
        setRows((current) => (skip === 0 ? page.data : [...current, ...page.data]));
        setTotal(page.total);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
      }
    },
    [client, boardId, transitionId]
  );

  useEffect(() => {
    if (!open || !client) return;
    void loadPage(0);
    // Keep an open history live: new advances arrive as `created` audit rows.
    const service = client.service('zone-workflow-advances');
    const created = (row: ZoneWorkflowAdvance) => {
      if (row.transition_id !== transitionId || shownIds.current.has(row.advance_id)) return;
      shownIds.current.add(row.advance_id);
      setRows((current) => [row, ...current]);
      setTotal((current) => current + 1);
    };
    service.on('created', created);
    return () => {
      service.off('created', created);
    };
  }, [open, client, transitionId, loadPage]);

  return (
    <Modal
      title={`Advance history — ${transition.label}`}
      open={open}
      onCancel={onClose}
      afterClose={afterClose}
      footer={<Button onClick={onClose}>Close</Button>}
      width={640}
    >
      {error && (
        <Alert type="error" showIcon title="Could not load advance history" description={error} />
      )}
      <List<ZoneWorkflowAdvance>
        loading={loading && rows.length === 0}
        dataSource={rows}
        locale={{ emptyText: 'Nothing has been advanced along this transition yet.' }}
        rowKey="advance_id"
        renderItem={(advance) => {
          const outcome = OUTCOME_LABELS[advance.prompt_outcome];
          return (
            <List.Item>
              <Flex vertical gap={4} style={{ width: '100%' }}>
                <Flex justify="space-between" align="center" gap={8} wrap>
                  <Typography.Text>
                    {advance.entities.map(describeEntity).join(', ')}
                  </Typography.Text>
                  <Tag color={outcome.color}>{outcome.label}</Tag>
                </Flex>
                <Typography.Text type="secondary">
                  {describeUser(advance.requested_by)} ·{' '}
                  <Tooltip title={formatAbsoluteTime(advance.requested_at)}>
                    <span>{formatRelativeTime(advance.requested_at)}</span>
                  </Tooltip>
                </Typography.Text>
                {advance.prompt_error && (
                  <Typography.Text type="danger">{advance.prompt_error}</Typography.Text>
                )}
              </Flex>
            </List.Item>
          );
        }}
      />
      {rows.length < total && (
        <Flex justify="center">
          <Button loading={loading} onClick={() => void loadPage(rows.length)}>
            Load more ({total - rows.length})
          </Button>
        </Flex>
      )}
    </Modal>
  );
}
