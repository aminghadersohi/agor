/**
 * Modal for configuring zone settings (name, triggers, etc.)
 */

import {
  defaultZoneLayoutSortDirection,
  normalizeZoneLayoutPolicy,
  setZoneLayoutMode,
  ZONE_LAYOUT_PRESET_LABELS,
  ZONE_LAYOUT_SORT_FIELDS,
  ZONE_LAYOUT_SORT_LABELS,
  ZONE_OVERFLOW_STRATEGIES,
  ZONE_OVERFLOW_STRATEGY_LABELS,
  zoneLayoutSortDirectionOptions,
} from '@agor/core/layout/zone-layout';
import type {
  AgenticToolName,
  BoardObject,
  ZoneLayoutMode,
  ZoneLayoutPreset,
  ZoneLayoutSortBy,
  ZoneLayoutSortDirection,
  ZoneOverflowStrategy,
  ZoneTriggerBehavior,
} from '@agor-live/client';
import { isAgenticToolName } from '@agor-live/client';
import {
  Alert,
  Divider,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Switch,
} from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useMutationGate } from '../../../contexts/ConnectionContext';
import { AgentSelectionGrid, AVAILABLE_AGENTS } from '../../AgentSelectionGrid';
import { ExpandableAlert } from '../../ExpandableAlert';

interface ZoneConfigModalProps {
  open: boolean;
  onCancel: () => void;
  zoneName: string;
  objectId: string;
  onUpdate: (
    objectId: string,
    objectData: BoardObject
  ) => boolean | undefined | Promise<boolean | undefined>;
  zoneData: BoardObject;
}

interface ZoneFormValues {
  name: string;
  triggerBehavior: ZoneTriggerBehavior;
  triggerTemplate: string;
  layoutMode: ZoneLayoutMode;
  layoutPreset: ZoneLayoutPreset;
  layoutSortBy: ZoneLayoutSortBy;
  layoutSortDirection: ZoneLayoutSortDirection;
  layoutColumns?: number;
  layoutGap: number;
  layoutAutoResizeHeight: boolean;
  layoutOnOverflow: ZoneOverflowStrategy;
}

// Sensible default so that a freshly-created zone always has a behavior
// selected — previously the field came up blank, the Select allowed clearing,
// and any template the user typed got silently discarded on save unless they
// also remembered to pick a behavior. With a default of 'show_picker', the
// template is preserved by default and users only need to opt OUT (by leaving
// the template empty) for an organizational-only zone.
const DEFAULT_TRIGGER_BEHAVIOR: ZoneTriggerBehavior = 'show_picker';

export const ZoneConfigModal = ({
  open,
  onCancel,
  zoneName,
  objectId,
  onUpdate,
  zoneData,
}: ZoneConfigModalProps) => {
  const [form] = Form.useForm<ZoneFormValues>();
  const [triggerAgent, setTriggerAgent] = useState<AgenticToolName | null>('claude-code');
  const isInitializingRef = useRef(false);
  const mutationGate = useMutationGate();

  const triggerBehavior = Form.useWatch('triggerBehavior', form);
  const layoutMode = Form.useWatch('layoutMode', form);
  const layoutPreset = Form.useWatch('layoutPreset', form);
  const layoutSortBy = Form.useWatch('layoutSortBy', form);
  const layoutAutoResizeHeight = Form.useWatch('layoutAutoResizeHeight', form);

  const zoneTrigger = zoneData.type === 'zone' ? zoneData.trigger : undefined;
  const hasZoneTrigger = Boolean(zoneTrigger);
  const zoneTriggerBehavior = zoneTrigger?.behavior;
  const zoneTriggerTemplate = zoneTrigger?.template;
  const zoneTriggerAgent = zoneTrigger?.agent;
  const requiresSupportedToolSelection = Boolean(
    zoneTriggerAgent && !isAgenticToolName(zoneTriggerAgent) && triggerAgent === null
  );

  // Reset form when modal opens (prevent WebSocket updates from erasing user input).
  // Keep dependencies to stable primitive fields: ZoneNode re-renders often, and
  // passing a freshly-created zone object through this effect used to make AntD's
  // Form/Modal tree re-run initialization work unnecessarily while open.
  useEffect(() => {
    if (open && !isInitializingRef.current) {
      isInitializingRef.current = true;
      if (hasZoneTrigger) {
        const layout = normalizeZoneLayoutPolicy(
          zoneData.type === 'zone' ? zoneData.layout : undefined
        );
        form.setFieldsValue({
          name: zoneName,
          triggerBehavior: zoneTriggerBehavior,
          triggerTemplate: zoneTriggerTemplate,
          layoutMode: layout.mode,
          layoutPreset: layout.preset,
          layoutSortBy: layout.sortBy,
          layoutSortDirection: layout.sortDirection,
          layoutColumns: layout.columns,
          layoutGap: layout.gap,
          layoutAutoResizeHeight: layout.autoResizeHeight === true,
          layoutOnOverflow: layout.onOverflow,
        });
        setTriggerAgent(
          zoneTriggerAgent === undefined
            ? 'claude-code'
            : isAgenticToolName(zoneTriggerAgent)
              ? zoneTriggerAgent
              : null
        );
      } else {
        const layout = normalizeZoneLayoutPolicy(
          zoneData.type === 'zone' ? zoneData.layout : undefined
        );
        form.setFieldsValue({
          name: zoneName,
          triggerBehavior: DEFAULT_TRIGGER_BEHAVIOR,
          triggerTemplate: '',
          layoutMode: layout.mode,
          layoutPreset: layout.preset,
          layoutSortBy: layout.sortBy,
          layoutSortDirection: layout.sortDirection,
          layoutColumns: layout.columns,
          layoutGap: layout.gap,
          layoutAutoResizeHeight: layout.autoResizeHeight === true,
          layoutOnOverflow: layout.onOverflow,
        });
        setTriggerAgent('claude-code');
      }
    } else if (!open) {
      isInitializingRef.current = false;
    }
  }, [
    open,
    zoneName,
    hasZoneTrigger,
    zoneTriggerBehavior,
    zoneTriggerTemplate,
    zoneTriggerAgent,
    zoneData,
    form,
  ]);

  const handleLayoutModeChange = (mode: ZoneLayoutMode) => {
    const next = setZoneLayoutMode(
      {
        // Ant Form normalizes the Switch value before onChange runs. Supply
        // the pre-toggle mode explicitly so the shared transition can detect
        // a real manual -> auto enable and choose its stable default sort.
        mode: mode === 'auto' ? 'manual' : 'auto',
        sortBy: form.getFieldValue('layoutSortBy'),
        sortDirection: form.getFieldValue('layoutSortDirection'),
      },
      mode
    );
    form.setFieldsValue({
      layoutMode: next.mode,
      layoutSortBy: next.sortBy,
      layoutSortDirection: next.sortDirection,
    });
  };

  const handleSortByChange = (sortBy: ZoneLayoutSortBy) => {
    form.setFieldValue('layoutSortDirection', defaultZoneLayoutSortDirection(sortBy));
  };

  const sortDirectionOptions = zoneLayoutSortDirectionOptions(layoutSortBy ?? 'position');

  const handleSave = async () => {
    if (!mutationGate.canMutate) return;
    if (requiresSupportedToolSelection || triggerAgent === null) return;
    try {
      const values = await form.validateFields();

      if (zoneData.type === 'zone') {
        const template = values.triggerTemplate?.trim() || '';
        const layout = normalizeZoneLayoutPolicy({
          mode: values.layoutMode,
          preset: values.layoutPreset,
          sortBy: values.layoutSortBy,
          sortDirection: values.layoutSortDirection,
          columns: values.layoutPreset === 'grid' ? values.layoutColumns : 1,
          gap: values.layoutGap,
          autoResizeHeight: values.layoutAutoResizeHeight,
          resize: values.layoutAutoResizeHeight
            ? normalizeZoneLayoutPolicy(zoneData.layout).resize === 'both'
              ? 'both'
              : 'height'
            : 'fixed',
          onOverflow: values.layoutOnOverflow,
        });
        const trigger =
          template && values.triggerBehavior
            ? {
                behavior: values.triggerBehavior,
                template,
                agent: triggerAgent,
              }
            : undefined;
        const hasChanges =
          values.name !== zoneName ||
          JSON.stringify(trigger) !== JSON.stringify(zoneData.trigger) ||
          JSON.stringify(layout) !== JSON.stringify(normalizeZoneLayoutPolicy(zoneData.layout));

        if (hasChanges) {
          const saved = await onUpdate(objectId, {
            ...zoneData,
            label: values.name,
            trigger,
            layout,
          });
          if (saved === false) return;
        }
      }
      onCancel();
    } catch {
      // Validation failed — form will show inline errors
    }
  };

  return (
    <Modal
      title="Configure zone"
      open={open}
      onCancel={onCancel}
      onOk={handleSave}
      okText="Save"
      okButtonProps={{
        disabled: !mutationGate.canMutate || requiresSupportedToolSelection,
      }}
      cancelText="Cancel"
      width={600}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="Zone name">
          <Input placeholder="Enter zone name..." size="large" />
        </Form.Item>

        <Divider plain>Layout</Divider>

        <Form.Item
          name="layoutMode"
          label="Auto Zone"
          valuePropName="checked"
          getValueProps={(value: ZoneLayoutMode) => ({ checked: value === 'auto' })}
          normalize={(checked: boolean) => (checked ? 'auto' : 'manual')}
          help={
            layoutMode === 'auto'
              ? 'On: keeps contents arranged with the saved settings below. It pauses for one minute while you use a stacked worktree.'
              : 'Off: preserves spatial memory. The settings below remain saved and apply when you choose Tidy up contents.'
          }
        >
          <Switch
            aria-label="Auto Zone"
            onChange={(checked) => {
              const mode: ZoneLayoutMode = checked ? 'auto' : 'manual';
              handleLayoutModeChange(mode);
            }}
          />
        </Form.Item>

        <Form.Item
          name="layoutPreset"
          label="Presentation"
          help={
            layoutPreset === 'compact_list'
              ? 'List uses one column and collapses worktree and capable generic-card details; header-only cards and canvas objects keep their natural size.'
              : undefined
          }
        >
          <Segmented
            block
            aria-label="Presentation"
            options={[
              { label: ZONE_LAYOUT_PRESET_LABELS.grid, value: 'grid' },
              { label: ZONE_LAYOUT_PRESET_LABELS.compact_list, value: 'compact_list' },
            ]}
          />
        </Form.Item>

        <Flex gap="middle" wrap>
          <Form.Item name="layoutSortBy" label="Sort by" style={{ flex: '1 1 220px' }}>
            <Select
              onChange={handleSortByChange}
              options={ZONE_LAYOUT_SORT_FIELDS.map((value) => ({
                value,
                label: ZONE_LAYOUT_SORT_LABELS[value],
              }))}
            />
          </Form.Item>
          <Form.Item name="layoutSortDirection" label="Order" style={{ flex: '1 1 150px' }}>
            <Select options={sortDirectionOptions} />
          </Form.Item>
        </Flex>

        <Flex gap="large" wrap align="start">
          {layoutPreset === 'grid' && (
            <Form.Item
              name="layoutColumns"
              label="Columns"
              help="Leave blank to fit as many columns as the zone allows."
              style={{ flex: '1 1 200px' }}
            >
              <InputNumber min={1} precision={0} style={{ width: '100%' }} placeholder="Auto" />
            </Form.Item>
          )}
          <Form.Item
            name="layoutGap"
            label="Spacing"
            help="Exact space between arranged items."
            style={{ flex: '1 1 160px' }}
          >
            <InputNumber
              min={0}
              max={96}
              precision={0}
              step={4}
              suffix="px"
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item
            name="layoutAutoResizeHeight"
            label="Grow to fit"
            valuePropName="checked"
            help="On: content may grow the zone and minimally move newly covered zones; a manual resize becomes its new floor. Off: the zone keeps its frame and an impossible tidy reports overflow without moving anything."
            style={{ flex: '1 1 200px' }}
          >
            <Switch
              aria-label="Grow to fit"
              onChange={(checked) => {
                if (checked) form.setFieldValue('layoutOnOverflow', 'reflow_board');
              }}
            />
          </Form.Item>
          <Form.Item
            name="layoutOnOverflow"
            label="When growth overlaps"
            help={
              layoutAutoResizeHeight
                ? 'Choose whether to report covered zones or minimally move the board zones out of the way.'
                : 'Enable Grow to fit before choosing an overlap action.'
            }
            style={{ flex: '1 1 240px' }}
          >
            <Select
              aria-label="When growth overlaps"
              disabled={!layoutAutoResizeHeight}
              options={ZONE_OVERFLOW_STRATEGIES.map((value) => ({
                value,
                label: ZONE_OVERFLOW_STRATEGY_LABELS[value],
              }))}
            />
          </Form.Item>
        </Flex>

        <Divider plain>Automation prompt</Divider>

        <Form.Item name="triggerBehavior" label="Trigger Behavior">
          {/* No allowClear / no placeholder: the field always has a value
              (DEFAULT_TRIGGER_BEHAVIOR for new zones), so there is no
              "unset" state to represent. To make a zone organizational
              only, leave the template empty. */}
          <Select
            style={{ width: '100%' }}
            options={[
              {
                value: 'show_picker',
                label: 'Show Picker - Choose session and action when dropped',
              },
              { value: 'always_new', label: 'Always New - Auto-create new root session' },
            ]}
          />
        </Form.Item>

        {requiresSupportedToolSelection && (
          <Alert
            type="warning"
            showIcon
            title="This zone uses a removed agentic tool"
            description="Its saved trigger is preserved, but it cannot create a session. Choose a supported tool to migrate the zone explicitly."
            style={{ marginBottom: 16 }}
          />
        )}

        {(triggerBehavior === 'always_new' || requiresSupportedToolSelection) && (
          <Form.Item
            label="Agent"
            help="New sessions will use the dropping user's default configuration for this agent."
          >
            <AgentSelectionGrid
              agents={AVAILABLE_AGENTS}
              selectedAgentId={triggerAgent}
              onSelect={(id) => setTriggerAgent(id as AgenticToolName)}
              columns={2}
              showHelperText={false}
              showComparisonLink={false}
            />
          </Form.Item>
        )}

        <Form.Item
          name="triggerTemplate"
          label="Trigger Template"
          help="Leave empty for an organizational-only zone (no trigger fires on drop)."
          extra={
            <ExpandableAlert
              // Re-mount when the modal opens or the zone changes so the
              // details collapse back to default; otherwise the AntD Modal
              // keeps children mounted and stale `expanded` state persists.
              key={`${objectId}:${open}`}
              title="Handlebars template support"
              summary="Reference branch, session, and board data with {{ ... }} syntax."
            >
              <p style={{ marginBottom: 8 }}>
                Use Handlebars syntax to reference session and board data in your trigger:
              </p>
              <ul style={{ marginLeft: 16, marginBottom: 8 }}>
                <li>
                  <code>{'{{ branch.issue_url }}'}</code> - GitHub issue URL
                </li>
                <li>
                  <code>{'{{ branch.pull_request_url }}'}</code> - Pull request URL
                </li>
                <li>
                  <code>{'{{ branch.notes }}'}</code> - Branch notes
                </li>
                <li>
                  <code>{'{{ session.description }}'}</code> - Session description
                </li>
                <li>
                  <code>{'{{ session.context.* }}'}</code> - Custom context from session settings
                </li>
                <li>
                  <code>{'{{ board.name }}'}</code> - Board name
                </li>
                <li>
                  <code>{'{{ board.description }}'}</code> - Board description
                </li>
                <li>
                  <code>{'{{ board.context.* }}'}</code> - Custom context from board settings
                </li>
              </ul>
              <p style={{ marginTop: 8, marginBottom: 0 }}>
                Example:{' '}
                <code>
                  {
                    'Review {{ branch.issue_url }} for {{ board.context.team }} sprint {{ board.context.sprint }}'
                  }
                </code>
              </p>
            </ExpandableAlert>
          }
        >
          <Input.TextArea
            placeholder="Enter the prompt template that will be triggered when a branch is dropped here..."
            rows={6}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};
