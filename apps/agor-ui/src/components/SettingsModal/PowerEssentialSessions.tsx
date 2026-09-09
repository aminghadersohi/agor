import type {
  AgorClient,
  PowerEssentialSessionOption,
  PowerEssentialSessionSearchResult,
  User,
} from '@agor-live/client';
import { shortId } from '@agor-live/client';
import { Alert, Button, Flex, Select, Spin, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import {
  useAuthenticatedAuthorityScope,
  useAuthorityOperationGuard,
} from '../../hooks/useAuthorityOperationGuard';
import { SessionPowerPriorityControl } from '../SessionSettingsModal/SessionPowerPriorityControl';

const SEARCH_LIMIT = 30;
const SEARCH_DEBOUNCE_MS = 300;

function optionLabel(session: PowerEssentialSessionOption): string {
  return `${session.title || 'Untitled'} · ${shortId(session.session_id)}${
    session.power_priority === 'essential' ? ' · Essential' : ''
  }`;
}

export function PowerEssentialSessions({ client, user }: { client: AgorClient; user: User }) {
  const scope = useAuthenticatedAuthorityScope(client, `${user.user_id}:${user.role}`);
  const guard = useAuthorityOperationGuard(scope.operationScope);
  const [search, setSearch] = useState('');
  const [_refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<PowerEssentialSessionSearchResult | null>(null);
  const [selected, setSelected] = useState<PowerEssentialSessionOption['session_id']>();
  const [loadedScope, setLoadedScope] = useState(scope.operationScope);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const operation = guard.begin();
    if (!operation.isCurrent()) return;
    setLoading(true);
    const timer = window.setTimeout(
      () => {
        const query = search.trim() ? { search: search.trim() } : undefined;
        void client
          .service('power-management/essential-sessions')
          .find(query ? { query } : undefined)
          .then((next) => {
            if (!operation.isCurrent()) return;
            setResult(next);
            setLoadedScope(scope.operationScope);
            setError(false);
          })
          .catch(() => {
            if (!operation.isCurrent()) return;
            setResult(null);
            setError(true);
          })
          .finally(() => {
            if (operation.isCurrent()) setLoading(false);
          });
      },
      search.trim() ? SEARCH_DEBOUNCE_MS : 0
    );
    return () => {
      window.clearTimeout(timer);
      operation.cancel();
    };
  }, [client, guard, scope.operationScope, search]);

  useEffect(() => {
    const sessions = client.service('sessions');
    const reload = () => setRefresh((value) => value + 1);
    sessions.on('patched', reload);
    sessions.on('removed', reload);
    return () => {
      sessions.off('patched', reload);
      sessions.off('removed', reload);
    };
  }, [client]);

  const options = useMemo(() => {
    const sessions = new Map(
      [result?.selected, ...(result?.data ?? [])]
        .filter((value): value is PowerEssentialSessionOption => Boolean(value))
        .map((session) => [session.session_id, session])
    );
    return [...sessions.values()].map((session) => ({
      value: session.session_id,
      label: optionLabel(session),
    }));
  }, [result]);

  if (!scope.connectionReady || loadedScope !== scope.operationScope) {
    return (
      <Alert
        type="warning"
        title="Session inventory unavailable. Reconnect to refresh authorized Sessions."
      />
    );
  }

  return (
    <Flex vertical gap="middle">
      <Typography.Text>
        One Essential Session may start during conservation, but not Critical or stable-online
        recovery. Only active Sessions on Branches you can manage are searchable; admin role alone
        does not grant access to other branches.
      </Typography.Text>

      <Flex vertical gap="small" aria-live="polite" aria-busy={loading}>
        <Typography.Text strong>Currently selected Essential Session</Typography.Text>
        {loading && !result ? (
          <Typography.Text type="secondary">Loading current selection…</Typography.Text>
        ) : result?.selected ? (
          <Flex gap="small" wrap align="center">
            <Typography.Text>{optionLabel(result.selected)}</Typography.Text>
            <Tag color="green">Essential</Tag>
            <Button type="link" onClick={() => setSelected(result.selected?.session_id)}>
              Manage current Session
            </Button>
          </Flex>
        ) : result?.slot_occupied ? (
          <Alert
            type="info"
            title="An Essential Session exists but is archived, ineligible, or outside your Branch access."
          />
        ) : (
          <Typography.Text type="secondary">No Essential Session is selected.</Typography.Text>
        )}
      </Flex>

      <Flex vertical gap="small">
        <Typography.Text id="power-essential-session-search-help" type="secondary">
          The first {SEARCH_LIMIT} recent eligible Sessions are shown. Search by title or Session ID
          to find older Sessions. Results stay server-bounded and never load hidden pages.
        </Typography.Text>
        <Select
          aria-label="Session to manage"
          aria-describedby="power-essential-session-search-help"
          placeholder="Search eligible Sessions"
          showSearch
          allowClear
          filterOption={false}
          searchValue={search}
          value={selected}
          loading={loading}
          status={error ? 'error' : undefined}
          onSearch={setSearch}
          onChange={(value) => setSelected(value)}
          options={options}
          listHeight={256}
          notFoundContent={
            loading ? (
              <Spin size="small" description="Searching Sessions" />
            ) : error ? (
              'Search unavailable'
            ) : search.trim() ? (
              'No eligible Sessions match this search'
            ) : (
              'No eligible Sessions are available'
            )
          }
          style={{ width: '100%', maxWidth: 720 }}
        />
        {error && (
          <Alert
            type="error"
            showIcon
            title="Eligible Sessions could not be loaded"
            description="No previous results are shown as current. Retry after reconnecting."
            action={<Button onClick={() => setRefresh((value) => value + 1)}>Retry</Button>}
          />
        )}
      </Flex>

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
