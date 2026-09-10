import type {
  AgorClient,
  AgorPowerManagementSettings,
  PowerManagementStatus,
} from '@agor-live/client';
import {
  POWER_MANAGEMENT_MODES,
  powerManagementMutableSettingsFromResolved,
  resolvePowerManagementConfig,
} from '@agor-live/client';
import { Alert, Button, Flex, Form, InputNumber, Popconfirm, Select, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';

const fields = [
  ['poll_interval_ms', 'Poll interval (ms)', 1000, 60000],
  ['provider_timeout_ms', 'Provider timeout (ms)', 100, 30000],
  ['stale_after_ms', 'Stale after (ms)', 2000, 300000],
  ['on_battery_debounce_ms', 'Battery debounce (ms)', 0, 300000],
  ['online_stable_ms', 'Stable online recovery (ms)', 1000, 600000],
  ['recovery_dispatch_interval_ms', 'Recovery dispatch spacing (ms)', 0, 60000],
  [['critical', 'charge_percent'], 'Critical charge (%)', 1, 100],
  [['critical', 'runtime_seconds'], 'Critical runtime (seconds)', 1, 86400],
  [['critical', 'consecutive_samples'], 'Consecutive critical samples', 1, 10],
  [
    ['communication_loss', 'last_on_battery_critical_after_ms'],
    'Communication loss after battery: critical delay (ms)',
    0,
    600000,
  ],
] as const;

export function PowerConfigurationEditor({
  client,
  status,
}: {
  client: AgorClient;
  status: PowerManagementStatus;
}) {
  const [form] = Form.useForm<AgorPowerManagementSettings>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const previousRevision = useRef(status.runtime_settings?.revision);
  const currentRevision = useRef(status.runtime_settings?.revision);
  const configuration = status.configuration;
  const runtime = status.runtime_settings;
  const draftMode = Form.useWatch('mode', form);

  useEffect(() => {
    if (!configuration) return;
    form.setFieldsValue(configuration);
    if (
      previousRevision.current !== undefined &&
      runtime?.revision !== undefined &&
      runtime.revision !== previousRevision.current
    ) {
      setNotice('Active policy changed. This form now shows the converged runtime revision.');
      setError('');
    }
    previousRevision.current = runtime?.revision;
    currentRevision.current = runtime?.revision;
  }, [configuration, form, runtime?.revision]);

  if (!configuration || !runtime) {
    return (
      <Alert
        type="warning"
        title="This daemon does not support live power-policy settings. Upgrade before applying changes."
      />
    );
  }

  const mutate = async (
    request:
      | { configuration: ReturnType<typeof powerManagementMutableSettingsFromResolved> }
      | { reset_to_operator_defaults: true }
      | { rollback_last_change: true },
    success: string
  ) => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const updated = await client.service('power-management').patch(null, {
        expected_revision: currentRevision.current ?? runtime.revision,
        ...request,
      });
      if (updated.configuration) form.setFieldsValue(updated.configuration);
      setNotice(success);
      previousRevision.current = updated.runtime_settings?.revision;
      currentRevision.current = updated.runtime_settings?.revision;
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code;
      setError(
        code === 409
          ? 'Another administrator applied a newer revision. The live status will refresh; review it before retrying.'
          : cause instanceof Error
            ? cause.message
            : 'Power policy could not be applied'
      );
    } finally {
      setSaving(false);
    }
  };

  const apply = (values: AgorPowerManagementSettings) => {
    try {
      const resolved = resolvePowerManagementConfig({
        ...values,
        provider: 'macos',
        max_essential_sessions: 1,
      });
      void mutate(
        { configuration: powerManagementMutableSettingsFromResolved(resolved) },
        `Revision ${runtime.revision + 1} is active without a daemon restart.`
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invalid power configuration');
    }
  };

  return (
    <Flex vertical gap="middle">
      <Alert
        type="info"
        showIcon
        title={`Live mutable policy · revision ${runtime.revision}`}
        description={
          runtime.source === 'runtime_override'
            ? 'The durable runtime override is active and takes precedence over operator defaults. Agor never rewrites config.yaml.'
            : 'Operator defaults are active. Applying creates a durable runtime override; config.yaml remains unchanged.'
        }
      />
      <Typography.Text>
        Active mode: {configuration.mode}. Provider identity and supported deployment topology
        remain operator-controlled. Off, Observe, thresholds, timing, and recovery pacing apply
        live. Running Tasks are never suspended or stopped.
      </Typography.Text>
      {status.ownership === 'lost' && (
        <Alert
          type="error"
          showIcon
          title="Apply unavailable until host ownership is restored by an operator restart"
        />
      )}
      <Form
        form={form}
        layout="vertical"
        initialValues={configuration}
        onFinish={apply}
        onValuesChange={() => {
          setError('');
          setNotice('');
        }}
      >
        <Form.Item name="mode" label="Mode" rules={[{ required: true }]}>
          <Select
            options={POWER_MANAGEMENT_MODES.map((value) => ({
              value,
              label: value.toUpperCase(),
            }))}
          />
        </Form.Item>
        <Form.Item label="Provider">
          <Select
            value="macos"
            disabled
            options={[{ value: 'macos', label: 'macOS — read-only system power status' }]}
          />
        </Form.Item>
        <Flex wrap gap="middle">
          {fields.map(([name, label, min, max]) => (
            <Form.Item
              key={label}
              name={typeof name === 'string' ? name : [...name]}
              label={label}
              rules={[{ required: true, message: 'Enter a value' }]}
            >
              <InputNumber aria-label={label} min={min} max={max} precision={0} />
            </Form.Item>
          ))}
        </Flex>
        <Typography.Paragraph type="secondary">
          Essential Session limit: 1. Timeout must be less than polling; stale age must allow two
          polls; stable recovery must be at least the battery debounce. Switching to Enforce starts
          from a conservative state and may immediately hold new work. Queued work stays durable.
        </Typography.Paragraph>
        <Flex gap="small" wrap>
          <Popconfirm
            title={
              draftMode === 'enforce'
                ? 'Apply Enforce live? New ordinary work may be held immediately.'
                : `Apply ${draftMode ?? 'this policy'} live?`
            }
            okText="Apply live"
            onConfirm={() => form.submit()}
          >
            <Button
              type="primary"
              loading={saving}
              disabled={saving || status.ownership === 'lost'}
            >
              Apply live
            </Button>
          </Popconfirm>
          <Button
            disabled={saving || status.ownership === 'lost'}
            onClick={() => {
              form.setFieldsValue(configuration);
              setError('');
              setNotice('Unsaved edits discarded.');
            }}
          >
            Discard unsaved edits
          </Button>
          <Popconfirm
            title="Remove the runtime override and apply current operator defaults live?"
            okText="Reset and apply"
            onConfirm={() =>
              void mutate(
                { reset_to_operator_defaults: true },
                'Operator defaults are active. config.yaml was not changed.'
              )
            }
          >
            <Button
              disabled={
                saving || status.ownership === 'lost' || runtime.source === 'operator_defaults'
              }
            >
              Reset to operator defaults
            </Button>
          </Popconfirm>
          <Popconfirm
            title="Apply the policy from immediately before this revision? Rollback creates a new audited revision."
            okText="Roll back live"
            onConfirm={() =>
              void mutate(
                { rollback_last_change: true },
                'The prior policy was restored as a new audited revision.'
              )
            }
          >
            <Button disabled={saving || !runtime.can_rollback}>Roll back last change</Button>
          </Popconfirm>
        </Flex>
      </Form>
      {error && <Alert type="error" showIcon title={error} />}
      {notice && <Alert type="success" showIcon title={notice} aria-live="polite" />}
      <Typography.Text type="secondary">
        Operator defaults: {(runtime.operator_defaults.mode ?? 'off').toUpperCase()}. Reset and
        rollback use the same revision check as Apply, so stale tabs cannot overwrite a newer
        decision.
      </Typography.Text>
    </Flex>
  );
}
