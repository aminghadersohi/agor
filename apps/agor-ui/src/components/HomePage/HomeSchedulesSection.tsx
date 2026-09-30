import type { AgorClient, Schedule, ScheduleID, UserPreferences } from '@agor-live/client';
import { humanizeCron } from '@agor-live/client';
import {
  ArrowDownOutlined,
  ArrowRightOutlined,
  BranchesOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Checkbox,
  Empty,
  Flex,
  Grid,
  Radio,
  Skeleton,
  Space,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectBranchById, selectSessionById, selectUserById } from '../../store/selectors';
import { formatRelativeTime } from '../../utils/time';
import { AdaptiveSettingsModal } from '../SettingsModal/AdaptiveSettingsModal';

const HOME_SCHEDULE_LIMIT = 12;

interface HomeSchedulesSectionProps {
  client: AgorClient | null;
  currentUserId?: string;
  onBranchClick?: (branchId: string) => void;
  compact?: boolean;
}

function scheduleSort(a: Schedule, b: Schedule): number {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  const aNext = a.next_run_at ?? Number.POSITIVE_INFINITY;
  const bNext = b.next_run_at ?? Number.POSITIVE_INFINITY;
  if (aNext !== bNext) return aNext - bNext;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function nextRunLabel(schedule: Schedule): string {
  if (!schedule.enabled) return 'Paused';
  if (!schedule.next_run_at) return 'Not scheduled';
  return formatRelativeTime(new Date(schedule.next_run_at).toISOString());
}

export function HomeSchedulesSection({
  client,
  currentUserId,
  onBranchClick,
  compact: compactOverride,
}: HomeSchedulesSectionProps) {
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const compact = compactOverride ?? !screens.md;
  const { message } = App.useApp();
  const branchById = useAgorStore(selectBranchById);
  const sessionById = useAgorStore(selectSessionById);
  const userById = useAgorStore(selectUserById);
  const currentUser = currentUserId ? userById.get(currentUserId) : undefined;
  const preference = currentUser?.preferences?.home_schedules;
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(Boolean(client));
  const [error, setError] = useState<string>();
  const [managerOpen, setManagerOpen] = useState(false);
  const [draftMode, setDraftMode] = useState<'all' | 'selected'>('all');
  const [draftIds, setDraftIds] = useState<ScheduleID[]>([]);
  const [saving, setSaving] = useState(false);

  const fetchSchedules = useCallback(async () => {
    if (!client) {
      setSchedules([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const result = await client.service('schedules').find({
        query: { $limit: 200, $sort: { next_run_at: 1, created_at: -1 } },
      });
      setSchedules((Array.isArray(result) ? result : result.data).sort(scheduleSort));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Schedules could not load');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void fetchSchedules();
  }, [fetchSchedules]);

  useEffect(() => {
    if (!client) return;
    const service = client.service('schedules');
    const onCreated = (schedule: Schedule) =>
      setSchedules((current) => [...current, schedule].sort(scheduleSort));
    const onPatched = (schedule: Schedule) =>
      setSchedules((current) =>
        current
          .map((candidate) =>
            candidate.schedule_id === schedule.schedule_id ? schedule : candidate
          )
          .sort(scheduleSort)
      );
    const onRemoved = (schedule: Schedule) =>
      setSchedules((current) =>
        current.filter((candidate) => candidate.schedule_id !== schedule.schedule_id)
      );
    service.on('created', onCreated);
    service.on('patched', onPatched);
    service.on('removed', onRemoved);
    return () => {
      service.off('created', onCreated);
      service.off('patched', onPatched);
      service.off('removed', onRemoved);
    };
  }, [client]);

  const selectedIdSet = useMemo(
    () => new Set(preference?.mode === 'selected' ? preference.schedule_ids : []),
    [preference]
  );
  const visibleSchedules = useMemo(
    () =>
      schedules
        .filter(
          (schedule) => preference?.mode !== 'selected' || selectedIdSet.has(schedule.schedule_id)
        )
        .slice(0, HOME_SCHEDULE_LIMIT),
    [preference?.mode, schedules, selectedIdSet]
  );

  const openManager = () => {
    setDraftMode(preference?.mode ?? 'all');
    setDraftIds(preference?.mode === 'selected' ? preference.schedule_ids : []);
    setManagerOpen(true);
  };

  const saveSelection = async () => {
    if (!client || !currentUser) return;
    setSaving(true);
    try {
      const homeSchedules = {
        mode: draftMode,
        schedule_ids: draftMode === 'selected' ? draftIds : [],
      } as const;
      const nextPreferences: UserPreferences = {
        ...(currentUser.preferences ?? {}),
        home_schedules: homeSchedules,
      };
      await client.service('users').patch(currentUser.user_id, { preferences: nextPreferences });
      setManagerOpen(false);
      message.success('Home schedules updated');
    } catch (nextError) {
      message.error(nextError instanceof Error ? nextError.message : 'Schedule selection failed');
    } finally {
      setSaving(false);
    }
  };

  const arrow = compact ? (
    <ArrowDownOutlined aria-hidden style={{ color: token.colorTextTertiary }} />
  ) : (
    <ArrowRightOutlined aria-hidden style={{ color: token.colorTextTertiary }} />
  );

  return (
    <section aria-labelledby="home-schedules-title" style={{ marginTop: token.marginLG }}>
      <Flex
        justify="space-between"
        align="center"
        gap={token.marginSM}
        style={{ marginBottom: token.marginSM }}
      >
        <div style={{ minWidth: 0 }}>
          <Typography.Title id="home-schedules-title" level={5} style={{ margin: 0 }}>
            Schedules
          </Typography.Title>
          <Typography.Text type="secondary">
            {preference?.mode === 'selected' ? 'Selected automations' : 'Upcoming automations'}
          </Typography.Text>
        </div>
        <Button icon={<SettingOutlined />} onClick={openManager} disabled={!currentUser || !client}>
          Choose
        </Button>
      </Flex>

      {error && (
        <Alert
          type="error"
          showIcon
          title="Schedules could not load"
          description={error}
          action={<Button onClick={() => void fetchSchedules()}>Retry</Button>}
          style={{ marginBottom: token.marginSM }}
        />
      )}
      {loading ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : visibleSchedules.length === 0 ? (
        <Card size="small">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              schedules.length > 0
                ? 'Choose schedules to show on Home'
                : 'No schedules in this workspace yet'
            }
          />
        </Card>
      ) : (
        <Flex vertical gap={token.marginSM}>
          {visibleSchedules.map((schedule) => {
            const branch = branchById.get(schedule.branch_id);
            const lastRun = schedule.last_run_session_id
              ? sessionById.get(schedule.last_run_session_id)
              : undefined;
            return (
              <Card
                key={schedule.schedule_id}
                size="small"
                styles={{ body: { padding: compact ? token.paddingSM : token.paddingMD } }}
              >
                <Flex vertical gap={token.marginSM}>
                  <Flex justify="space-between" align="center" gap={token.marginSM}>
                    <Typography.Text
                      strong
                      ellipsis={{ tooltip: schedule.name }}
                      style={{ minWidth: 0 }}
                    >
                      {schedule.name}
                    </Typography.Text>
                    <Badge
                      status={schedule.enabled ? 'processing' : 'default'}
                      text={schedule.enabled ? 'Active' : 'Paused'}
                    />
                  </Flex>
                  <Flex
                    vertical={compact}
                    align="center"
                    gap={compact ? token.marginXS : token.marginSM}
                    style={{ width: '100%', minWidth: 0 }}
                  >
                    <Card
                      size="small"
                      style={{ flex: 1, width: compact ? '100%' : undefined, minWidth: 0 }}
                    >
                      <Space align="start">
                        <ClockCircleOutlined style={{ color: token.colorPrimary }} />
                        <div style={{ minWidth: 0 }}>
                          <Typography.Text
                            type="secondary"
                            style={{ display: 'block', fontSize: token.fontSizeSM }}
                          >
                            Trigger
                          </Typography.Text>
                          <Typography.Text
                            ellipsis={{ tooltip: humanizeCron(schedule.cron_expression) }}
                          >
                            {humanizeCron(schedule.cron_expression)}
                          </Typography.Text>
                        </div>
                      </Space>
                    </Card>
                    {arrow}
                    <Card
                      size="small"
                      style={{ flex: 1.15, width: compact ? '100%' : undefined, minWidth: 0 }}
                    >
                      <Space align="start">
                        <BranchesOutlined style={{ color: token.colorInfo }} />
                        <div style={{ minWidth: 0 }}>
                          <Typography.Text
                            type="secondary"
                            style={{ display: 'block', fontSize: token.fontSizeSM }}
                          >
                            Worktree
                          </Typography.Text>
                          {branch && onBranchClick ? (
                            <Button
                              type="link"
                              size="small"
                              style={{ height: 'auto', padding: 0 }}
                              onClick={() => onBranchClick(branch.branch_id)}
                            >
                              <Typography.Text ellipsis={{ tooltip: branch.name }}>
                                {branch.name}
                              </Typography.Text>
                            </Button>
                          ) : (
                            <Typography.Text ellipsis={{ tooltip: branch?.name }}>
                              {branch?.name ?? 'Unavailable'}
                            </Typography.Text>
                          )}
                        </div>
                      </Space>
                    </Card>
                    {arrow}
                    <Card
                      size="small"
                      style={{ flex: 0.9, width: compact ? '100%' : undefined, minWidth: 0 }}
                    >
                      <Space align="start">
                        <CalendarOutlined style={{ color: token.colorSuccess }} />
                        <div style={{ minWidth: 0 }}>
                          <Typography.Text
                            type="secondary"
                            style={{ display: 'block', fontSize: token.fontSizeSM }}
                          >
                            Next run
                          </Typography.Text>
                          <Typography.Text>{nextRunLabel(schedule)}</Typography.Text>
                          {lastRun && (
                            <Typography.Text
                              type="secondary"
                              style={{ display: 'block', fontSize: token.fontSizeSM }}
                            >
                              Last: {lastRun.status.replaceAll('_', ' ')}
                            </Typography.Text>
                          )}
                        </div>
                      </Space>
                    </Card>
                  </Flex>
                </Flex>
              </Card>
            );
          })}
          {schedules.length > HOME_SCHEDULE_LIMIT && preference?.mode !== 'selected' && (
            <Typography.Text type="secondary" style={{ textAlign: 'center' }}>
              Showing the next {HOME_SCHEDULE_LIMIT} of {schedules.length} schedules
            </Typography.Text>
          )}
        </Flex>
      )}

      <AdaptiveSettingsModal
        title="Schedules on Home"
        open={managerOpen}
        onCancel={() => setManagerOpen(false)}
        onOk={() => void saveSelection()}
        okText="Save"
        confirmLoading={saving}
        width={560}
      >
        <Flex vertical gap={token.marginMD} style={{ minWidth: 0 }}>
          <Radio.Group
            value={draftMode}
            onChange={(event) => setDraftMode(event.target.value)}
            optionType="button"
            buttonStyle="solid"
            options={[
              { label: 'All schedules', value: 'all' },
              { label: 'Choose schedules', value: 'selected' },
            ]}
          />
          {draftMode === 'selected' && (
            <Checkbox.Group
              value={draftIds}
              onChange={(values) => setDraftIds(values as ScheduleID[])}
              style={{ width: '100%' }}
            >
              <Flex vertical gap={token.marginXS} style={{ width: '100%' }}>
                {schedules.map((schedule) => {
                  const branch = branchById.get(schedule.branch_id);
                  return (
                    <Card
                      key={schedule.schedule_id}
                      size="small"
                      styles={{ body: { padding: token.paddingSM } }}
                    >
                      <Checkbox value={schedule.schedule_id} style={{ width: '100%' }}>
                        <span
                          style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0 }}
                        >
                          <Typography.Text>{schedule.name}</Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                            {branch?.name ?? 'Unavailable worktree'} ·{' '}
                            {humanizeCron(schedule.cron_expression)}
                          </Typography.Text>
                        </span>
                      </Checkbox>
                    </Card>
                  );
                })}
              </Flex>
            </Checkbox.Group>
          )}
        </Flex>
      </AdaptiveSettingsModal>
    </section>
  );
}
