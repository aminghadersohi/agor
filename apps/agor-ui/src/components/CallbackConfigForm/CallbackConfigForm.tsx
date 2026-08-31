/**
 * Callback Configuration Form
 *
 * Allows configuring parent session callback behavior for child session completions:
 * - Enable/disable callbacks
 * - Customize callback message template
 * - Control last message inclusion
 */

import { Form, Input, Select, Switch, Typography } from 'antd';
import type React from 'react';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

export interface CallbackConfigFormProps {
  showHelpText?: boolean;
}

/**
 * Callback Configuration Form Component
 *
 * Used in SessionSettingsModal to configure callback behavior
 */
export const CallbackConfigForm: React.FC<CallbackConfigFormProps> = ({ showHelpText = false }) => {
  return (
    <>
      {/* Enable/Disable Callbacks */}
      <Form.Item
        name={['callbackConfig', 'enabled']}
        label="Enable Child Completion Callbacks"
        valuePropName="checked"
      >
        <Switch />
      </Form.Item>
      {showHelpText && (
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: -16, marginBottom: 16 }}>
          When enabled, this session will receive notifications when spawned child sessions complete
          their tasks. The callback message includes the child's final result inline.
        </Paragraph>
      )}

      <Form.Item name={['callbackConfig', 'delivery']} label="Callback Delivery">
        <Select
          options={[
            { value: 'direct', label: 'Direct (default)' },
            { value: 'btw', label: 'BTW digest' },
            { value: 'auto', label: 'Auto' },
          ]}
        />
      </Form.Item>
      {showHelpText && (
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: -16, marginBottom: 16 }}>
          BTW digests a standing callback in an ephemeral fork of its destination and returns one
          compact result. Auto uses BTW only when the destination is busy or the rendered callback
          is at least 8 KiB. If BTW is unavailable, Agor delivers the original callback directly.
        </Paragraph>
      )}

      {/* Include Last Message Toggle */}
      <Form.Item
        name={['callbackConfig', 'includeLastMessage']}
        label="Include Child's Final Answer"
        valuePropName="checked"
      >
        <Switch defaultChecked />
      </Form.Item>
      {showHelpText && (
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: -16, marginBottom: 16 }}>
          Include the child session's last assistant message in the callback. Disable if you only
          want task status and statistics.
        </Paragraph>
      )}

      {/* Custom Template (Optional) */}
      <Form.Item
        name={['callbackConfig', 'template']}
        label={
          <>
            Custom Template <Text type="secondary">(Optional)</Text>
          </>
        }
      >
        <TextArea
          placeholder="Leave empty to use default template..."
          autoSize={{ minRows: 4, maxRows: 12 }}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </Form.Item>
      {showHelpText && (
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: -16 }}>
          Advanced: Customize the callback message template using Handlebars syntax. Available
          variables: <Text code>childSessionId</Text>, <Text code>childSessionTitle</Text>,{' '}
          <Text code>spawnPrompt</Text>, <Text code>status</Text>, <Text code>messageCount</Text>,{' '}
          <Text code>toolUseCount</Text>, <Text code>lastAssistantMessage</Text>
        </Paragraph>
      )}
    </>
  );
};
