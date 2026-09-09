import type { AgorClient, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { Alert, Card, Descriptions, Flex, Spin, Tag, Typography } from 'antd';
import { usePowerManagementStatus } from '../../hooks/usePowerManagementStatus';
import { powerPolicyLabel, powerSourcePresentation } from '../PowerStatusIndicator';
import { PowerConfigurationEditor } from './PowerConfigurationEditor';
import { PowerEssentialSessions } from './PowerEssentialSessions';

function AdminPowerManagement({ client, user }: { client: AgorClient; user: User }) {
  const { status, error } = usePowerManagementStatus(client, `${user.user_id}:${user.role}`);
  const source = powerSourcePresentation(status, error);
  return (
    <Flex vertical gap="middle">
      <Typography.Title level={3}>UPS power management</Typography.Title>
      {error ? (
        <Alert
          type="error"
          showIcon
          title="Power status unavailable"
          description="The connection or authorization failed. Monitoring retries automatically; previous readings are not shown as current."
        />
      ) : !status ? (
        <Spin description="Reading power policy">
          <div />
        </Spin>
      ) : (
        <>
          <Card
            title="Power source monitoring"
            extra={<Tag color={source.color}>{source.label}</Tag>}
          >
            <Descriptions
              column={1}
              size="small"
              items={[
                {
                  key: 'provider',
                  label: 'Configured provider',
                  children:
                    status.configuration?.provider === 'macos'
                      ? 'macOS native power source'
                      : 'Not reported',
                },
                {
                  key: 'health',
                  label: 'Provider health',
                  children: source.detected ? 'Available' : source.label,
                },
                {
                  key: 'ups',
                  label: 'UPS',
                  children: source.detected ? 'Detected' : 'Detection unavailable',
                },
                {
                  key: 'source',
                  label: 'Power source',
                  children: source.detected ? source.label : 'Unavailable',
                },
                {
                  key: 'charge',
                  label: 'Charge',
                  children:
                    status.observation?.charge_percent === undefined
                      ? 'Not reported'
                      : `${status.observation.charge_percent}%`,
                },
                {
                  key: 'runtime',
                  label: 'Remaining runtime',
                  children:
                    status.observation?.runtime_seconds === undefined
                      ? 'Not reported'
                      : `${status.observation.runtime_seconds} seconds`,
                },
                {
                  key: 'observed',
                  label: 'Provider read (UTC)',
                  children: status.observation?.observed_at ?? 'Not reported',
                },
                {
                  key: 'age',
                  label: 'Observation age at refresh',
                  children:
                    status.observation_age_ms === undefined
                      ? 'Not reported'
                      : `${Math.ceil(status.observation_age_ms / 1000)} seconds`,
                },
              ]}
            />
            <Typography.Paragraph type="secondary">
              Refreshes every 5 seconds. Values are the latest privacy-filtered provider read, not a
              battery estimate. Missing values are not zero. Unavailable or stale readings never
              claim that a UPS is healthy or currently detected.
            </Typography.Paragraph>
          </Card>
          <Card title="Power conservation policy" extra={<Tag>{powerPolicyLabel(status)}</Tag>}>
            <Descriptions
              column={1}
              size="small"
              items={[
                {
                  key: 'mode',
                  label: 'Power conservation',
                  children: powerPolicyLabel(status),
                },
                { key: 'state', label: 'Policy state', children: status.state },
                {
                  key: 'reason',
                  label: 'Policy reason',
                  children: status.reason.replaceAll('_', ' '),
                },
                {
                  key: 'transition',
                  label: 'Policy state changed (UTC)',
                  children: status.transitioned_at,
                },
                {
                  key: 'admission',
                  label: 'Ordinary dispatch / schedules',
                  children: status.held ? 'Held by power policy' : 'Not held by power policy',
                },
                {
                  key: 'would',
                  label: 'If enforcement were active',
                  children: status.would_hold
                    ? 'Ordinary work would be held'
                    : 'Ordinary work would be admitted',
                },
                {
                  key: 'essential',
                  label: 'Essential dispatch',
                  children:
                    status.mode !== 'enforce' ||
                    ['normal', 'disabled', 'conserve'].includes(status.state)
                      ? 'Not held by power policy'
                      : 'Held by power policy',
                },
                {
                  key: 'recovery',
                  label: 'Stable-online recovery',
                  children:
                    status.recovery_remaining_ms === undefined
                      ? 'Not waiting for stability'
                      : `${Math.ceil(status.recovery_remaining_ms / 1000)} seconds remaining at refresh`,
                },
                {
                  key: 'pacing',
                  label: 'Recovery queue pacing',
                  children:
                    status.recovery_pacing === undefined
                      ? 'Not reported'
                      : status.recovery_pacing
                        ? 'Active until the recovery queue drains'
                        : 'Inactive',
                },
              ]}
            />
            <Typography.Paragraph type="secondary">
              Held is an admission decision, not a queued-task count; the API does not expose a
              held-work inventory. Other admission rules still apply. Running Tasks are never
              stopped.
            </Typography.Paragraph>
            {status.mode === 'off' && (
              <Alert
                type="info"
                showIcon
                title="Power conservation is Off — Sessions and schedules are unaffected by UPS conditions"
                description="An authorized deployment admin can prepare an Observe or Enforce draft below, merge the execution.power_management settings into the operator-managed config.yaml, and restart the daemon. Start with Observe and validate normal samples before choosing Enforce. This page never changes live configuration."
              />
            )}
            {status.mode === 'observe' && (
              <Alert
                type="info"
                showIcon
                title="Power conservation is Observe — Sessions are not gated"
                description="Agor calculates what Enforce would hold, but does not hold dispatch or schedules."
              />
            )}
          </Card>
          <Card title="Configure power policy">
            {status.configuration ? (
              <PowerConfigurationEditor configuration={status.configuration} />
            ) : (
              <Alert
                type="warning"
                title="This daemon does not expose active configuration. Upgrade the daemon to prepare a configuration draft."
              />
            )}
          </Card>
        </>
      )}
      <Card title="Essential Session">
        <PowerEssentialSessions client={client} user={user} />
      </Card>
    </Flex>
  );
}

export function PowerManagementTab({
  client,
  currentUser,
}: {
  client: AgorClient | null;
  currentUser?: User | null;
}) {
  if (!client || !currentUser || !hasMinimumRole(currentUser.role, ROLES.ADMIN)) return null;
  return (
    <AdminPowerManagement
      key={`${currentUser.user_id}:${currentUser.role}`}
      client={client}
      user={currentUser}
    />
  );
}
