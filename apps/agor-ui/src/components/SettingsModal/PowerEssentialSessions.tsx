import type { AgorClient, Session, User } from '@agor-live/client';
import { shortId } from '@agor-live/client';
import { Alert, Flex, Pagination, Select, Typography } from 'antd';
import { useEffect, useState } from 'react';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from '../../hooks/useAuthorityOperationGuard';
import { SessionPowerPriorityControl } from '../SessionSettingsModal/SessionPowerPriorityControl';

const PAGE_SIZE = 50;

export function PowerEssentialSessions({ client, user }: { client: AgorClient; user: User }) {
  const scope = useAuthenticatedAuthorityScope(client, `${user.user_id}:${user.role}`);
  const guard = useAuthorityOperationGuard(scope.operationScope);
  const [page, setPage] = useState(1);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [essential, setEssential] = useState<Session[]>([]);
  const [selected, setSelected] = useState<Session['session_id']>();
  const [total, setTotal] = useState(0);
  const [loadedScope, setLoadedScope] = useState(scope.operationScope);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const operation = guard.begin();
    if (!operation.isCurrent()) return;
    let pending = false;
    const load = async () => {
      if (pending || !operation.isCurrent()) return;
      pending = true;
      try {
        const service = client.service('sessions');
        const [list, priority] = await Promise.all([
          service.find({
            query: {
              $sort: { updated_at: -1 },
              $limit: PAGE_SIZE,
              $skip: (page - 1) * PAGE_SIZE,
            },
          }),
          service.find({ query: { power_priority: 'essential', $limit: 1 } }),
        ]);
        if (!operation.isCurrent()) return;
        const nextSessions = Array.isArray(list) ? list : list.data;
        const nextTotal = Array.isArray(list) ? list.length : list.total;
        const lastPage = Math.max(1, Math.ceil(nextTotal / PAGE_SIZE));
        if (page > lastPage) {
          setPage(lastPage);
          setSelected(undefined);
          return;
        }
        setSessions(nextSessions);
        setTotal(nextTotal);
        setEssential(
          (Array.isArray(priority) ? priority : priority.data).filter(
            (session) => session.power_priority === 'essential'
          )
        );
        setLoadedScope(scope.operationScope);
        setError(false);
      } catch {
        if (operation.isCurrent()) {
          setError(true);
          setSessions([]);
          setEssential([]);
        }
      } finally {
        pending = false;
        if (operation.isCurrent()) setLoading(false);
      }
    };
    setLoading(true);
    void load();
    const service = client.service('sessions');
    service.on('patched', load);
    service.on('removed', load);
    const timer = window.setInterval(() => void load(), 10000);
    return () => {
      operation.cancel();
      window.clearInterval(timer);
      service.off('patched', load);
      service.off('removed', load);
    };
  }, [client, guard, page, scope.operationScope]);
  if (!scope.connectionReady || loadedScope !== scope.operationScope || error)
    return (
      <Alert
        type="warning"
        title="Session inventory unavailable. Reconnect to refresh authorized Sessions."
      />
    );
  return (
    <Flex vertical gap="middle">
      <Typography.Text>
        One Essential Session may start during conservation, but not Critical or stable-online
        recovery. Branch Manager authority is required; admin role alone does not grant access to
        other branches.
      </Typography.Text>
      <Typography.Text strong>
        {loading
          ? 'Loading authorized Sessions…'
          : essential.length
            ? `Visible Essential Session: ${essential[0].title || shortId(essential[0].session_id)}`
            : 'No Essential Session is visible to you.'}
      </Typography.Text>
      <Typography.Text type="secondary">
        Only authorized Sessions are listed, including archived Sessions. An inaccessible Session
        may occupy the single slot. Clear the current priority before selecting a replacement;
        changes use the existing priority API, not an automatic transfer.
      </Typography.Text>
      <Select
        aria-label="Session to manage"
        placeholder="Choose a Session"
        showSearch
        optionFilterProp="label"
        value={selected}
        loading={loading}
        onChange={setSelected}
        options={[
          ...new Map(
            [...essential, ...sessions].map((session) => [session.session_id, session])
          ).values(),
        ].map((session) => ({
          value: session.session_id,
          label: `${session.title || 'Untitled'} · ${shortId(session.session_id)}${session.archived ? ' (archived)' : ''}${session.power_priority === 'essential' ? ' · Essential' : ''}`,
        }))}
      />
      {total > PAGE_SIZE && (
        <Pagination
          aria-label="Authorized Sessions pages"
          current={page}
          pageSize={PAGE_SIZE}
          total={total}
          size="small"
          responsive
          showLessItems
          showSizeChanger={false}
          onChange={(value) => {
            setPage(value);
            setSelected(undefined);
          }}
        />
      )}
      {selected && (
        <SessionPowerPriorityControl
          key={`${selected}:${scope.authGeneration}`}
          client={client}
          sessionId={selected}
        />
      )}
    </Flex>
  );
}
