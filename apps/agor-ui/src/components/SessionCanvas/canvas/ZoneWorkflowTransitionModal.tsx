import type { ZoneWorkflowTransition, ZoneWorkflowTransitionBehavior } from '@agor-live/client';
import { Alert, Form, Input, Modal, Select, Switch } from 'antd';
import { useEffect } from 'react';

export interface ZoneWorkflowTransitionValues {
  label: string;
  reason?: string;
  enabled: boolean;
  behavior: ZoneWorkflowTransitionBehavior;
}

interface Props {
  open: boolean;
  transition?: ZoneWorkflowTransition;
  sourceLabel: string;
  targetLabel: string;
  disabled?: boolean;
  onCancel: () => void;
  onSave: (values: ZoneWorkflowTransitionValues) => Promise<void>;
}

export function ZoneWorkflowTransitionModal({
  open,
  transition,
  sourceLabel,
  targetLabel,
  disabled,
  onCancel,
  onSave,
}: Props) {
  const [form] = Form.useForm<ZoneWorkflowTransitionValues>();
  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      label: transition?.label ?? `${sourceLabel} → ${targetLabel}`,
      reason: transition?.reason,
      enabled: transition?.enabled ?? true,
      behavior: transition?.behavior ?? 'guidance_only',
    });
  }, [form, open, transition, sourceLabel, targetLabel]);

  return (
    <Modal
      title={transition ? 'Edit workflow transition' : 'Create workflow transition'}
      open={open}
      onCancel={onCancel}
      okText={transition ? 'Save' : 'Create'}
      okButtonProps={{ disabled }}
      onOk={async () => onSave(await form.validateFields())}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        title={`${sourceLabel} → ${targetLabel}`}
        description="Advances are always explicit and confirmed. Manual moves keep their existing zone-trigger behavior and never count as workflow advances."
        style={{ marginBottom: 16 }}
      />
      <Form form={form} layout="vertical">
        <Form.Item name="label" label="Label" rules={[{ required: true, whitespace: true }]}>
          <Input maxLength={120} />
        </Form.Item>
        <Form.Item name="reason" label="Reason / guidance">
          <Input.TextArea maxLength={1000} rows={3} />
        </Form.Item>
        <Form.Item name="behavior" label="On advance">
          <Select
            options={[
              { value: 'guidance_only', label: 'Guidance only — move without prompting' },
              {
                value: 'target_zone_prompt',
                label: 'Use authorized target-zone prompt',
              },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="enabled"
          label="Enabled"
          valuePropName="checked"
          help="Disabled transitions remain visible but cannot be advanced."
        >
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}
