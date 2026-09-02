import type {
  AgorClient,
  BoardID,
  ZoneWorkflowAdvance,
  ZoneWorkflowAdvanceRequest,
  ZoneWorkflowTransition,
  ZoneWorkflowTransitionCreate,
  ZoneWorkflowTransitionPatch,
} from '@agor-live/client';
import { useCallback, useEffect, useState } from 'react';

function upsert(
  rows: ZoneWorkflowTransition[],
  incoming: ZoneWorkflowTransition
): ZoneWorkflowTransition[] {
  const index = rows.findIndex((row) => row.transition_id === incoming.transition_id);
  if (index < 0) return [...rows, incoming];
  if (rows[index] === incoming) return rows;
  const next = [...rows];
  next[index] = incoming;
  return next;
}

/** Board-scoped snapshot plus Feathers realtime reconciliation. */
export function useZoneWorkflow(client: AgorClient | null, boardId?: BoardID) {
  const [transitions, setTransitions] = useState<ZoneWorkflowTransition[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!client || !boardId) {
      setTransitions([]);
      return;
    }
    setLoading(true);
    try {
      const result = await client.service('zone-workflow-transitions').find({
        query: { board_id: boardId },
      });
      setTransitions(Array.isArray(result) ? result : result.data);
    } finally {
      setLoading(false);
    }
  }, [client, boardId]);

  useEffect(() => {
    if (!client || !boardId) {
      setTransitions([]);
      return;
    }
    const service = client.service('zone-workflow-transitions');
    const created = (row: ZoneWorkflowTransition) => {
      if (row.board_id === boardId) setTransitions((current) => upsert(current, row));
    };
    const patched = created;
    const removed = (row: ZoneWorkflowTransition) =>
      setTransitions((current) =>
        current.filter((candidate) => candidate.transition_id !== row.transition_id)
      );
    const connected = () => void refresh().catch(console.error);
    void refresh().catch(console.error);
    service.on('created', created);
    service.on('patched', patched);
    service.on('removed', removed);
    client.io.on('connect', connected);
    return () => {
      service.off('created', created);
      service.off('patched', patched);
      service.off('removed', removed);
      client.io.off('connect', connected);
    };
  }, [client, boardId, refresh]);

  const create = useCallback(
    async (data: Omit<ZoneWorkflowTransitionCreate, 'board_id'>) => {
      if (!client || !boardId) throw new Error('Board is unavailable');
      const row = await client
        .service('zone-workflow-transitions')
        .create({ ...data, board_id: boardId });
      setTransitions((current) => upsert(current, row));
      return row;
    },
    [client, boardId]
  );

  const patch = useCallback(
    async (id: string, data: ZoneWorkflowTransitionPatch) => {
      if (!client) throw new Error('Board is unavailable');
      const row = await client.service('zone-workflow-transitions').patch(id, data);
      setTransitions((current) => upsert(current, row));
      return row;
    },
    [client]
  );

  const remove = useCallback(
    async (id: string) => {
      if (!client) throw new Error('Board is unavailable');
      await client.service('zone-workflow-transitions').remove(id);
      setTransitions((current) => current.filter((candidate) => candidate.transition_id !== id));
    },
    [client]
  );

  const advance = useCallback(
    async (request: ZoneWorkflowAdvanceRequest): Promise<ZoneWorkflowAdvance> => {
      if (!client) throw new Error('Board is unavailable');
      return client.service('zone-workflow-advances').create(request);
    },
    [client]
  );

  return { transitions, loading, refresh, create, patch, remove, advance };
}
