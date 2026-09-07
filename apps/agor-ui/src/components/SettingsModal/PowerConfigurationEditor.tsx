import type { AgorPowerManagementSettings } from '@agor-live/client';
import {
  POWER_MANAGEMENT_MODES,
  powerManagementSettingsFromResolved,
  resolvePowerManagementConfig,
} from '@agor-live/client';
import { dump } from '@agor-live/client/yaml';
import { Alert, Button, Flex, Form, InputNumber, Select, Typography } from 'antd';
import { useState } from 'react';

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
  configuration,
}: {
  configuration: AgorPowerManagementSettings;
}) {
  const [form] = Form.useForm<AgorPowerManagementSettings>();
  const [yaml, setYaml] = useState('');
  const [error, setError] = useState('');
  const generate = (values: AgorPowerManagementSettings) => {
    try {
      const resolved = resolvePowerManagementConfig({
        ...values,
        provider: 'macos',
        max_essential_sessions: 1,
      });
      setYaml(
        dump({ execution: { power_management: powerManagementSettingsFromResolved(resolved) } })
      );
      setError('');
    } catch (cause) {
      setYaml('');
      setError(cause instanceof Error ? cause.message : 'Invalid power configuration');
    }
  };
  return (
    <Flex vertical gap="middle">
      <Alert
        type="info"
        showIcon
        title="Configuration draft — not applied"
        description="This daemon has no configuration-write API. Generate the supported YAML, merge only execution.power_management into the operator-managed configuration, then restart the daemon. Reopen this page to verify the active values. No changes here affect admission."
      />
      <Typography.Text>
        Active mode: {configuration.mode}. Only macOS, standalone, static-tenant, SQLite and simple
        local execution are supported when active. Start with Observe; Enforce may hold new work.
        Off disables the policy. Running work is never stopped.
      </Typography.Text>
      <Form
        form={form}
        layout="vertical"
        initialValues={configuration}
        onFinish={generate}
        onValuesChange={() => {
          setYaml('');
          setError('');
        }}
      >
        <Form.Item name="mode" label="Draft mode" rules={[{ required: true }]}>
          <Select
            options={POWER_MANAGEMENT_MODES.map((value) => ({ value, label: value.toUpperCase() }))}
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
          Essential Session limit: 1. Thresholds use charge or runtime only when the provider
          reports them. Timeout must be less than polling; stale age must allow two polls; stable
          recovery must be at least the battery debounce.
        </Typography.Paragraph>
        <Flex gap="small" wrap>
          <Button type="primary" htmlType="submit">
            Validate and generate YAML
          </Button>
          <Button
            onClick={() => {
              form.setFieldsValue(configuration);
              setYaml('');
              setError('');
            }}
          >
            Reset draft to active configuration
          </Button>
        </Flex>
      </Form>
      {error && <Alert type="error" showIcon title={error} />}
      {yaml && (
        <>
          <Alert
            type="warning"
            title="Validated draft only — restart required after operator installation"
          />
          <Typography.Paragraph copyable={{ text: yaml }}>
            <pre>{yaml}</pre>
          </Typography.Paragraph>
        </>
      )}
    </Flex>
  );
}
