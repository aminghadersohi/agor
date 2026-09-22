/**
 * EntityColorPicker — the swatch popover used to set a board entity's
 * user-chosen color (branch cards and cards).
 *
 * Color here is an organisational label in the Trello sense: a human picks it
 * to group work or mark priority. Nothing in this component (or anything that
 * reads `color_override`) derives a color from status.
 *
 * Shape follows the zone appearance popover in `BoardObjectNodes`: a small
 * icon button on the entity's header opens a popover of swatches. The
 * difference is that an entity color is optional, so this offers an explicit
 * "No color" alongside the palette, and a free-form `ColorPicker` for anyone
 * who wants a hue outside the eight presets.
 */

import { BgColorsOutlined, CheckOutlined } from '@ant-design/icons';
import { Button, ColorPicker, Flex, Popover, Space, Tooltip, Typography, theme } from 'antd';
import type { Color } from 'antd/es/color-picker';
import { useState } from 'react';
import { boardEntityPalette } from '../../utils/boardEntityColors';
import { REACT_FLOW_NO_DRAG_CLASS } from '../../utils/reactFlowDragClasses';

const SWATCH_SIZE = 26;

export interface EntityColorPickerProps {
  /** Current persisted color, or undefined when the entity has none. */
  value?: string;
  /**
   * Persist a new color, or `null` to clear it. May reject — the caller owns
   * surfacing the failure, since it also owns the service call.
   */
  onChange: (color: string | null) => void | Promise<void>;
  /** Disables the trigger (no permission, disconnected, entity being deleted). */
  disabled?: boolean;
  /** Tooltip shown on the trigger; also its accessible name. */
  label?: string;
}

export const EntityColorPicker = ({
  value,
  onChange,
  disabled = false,
  label = 'Card color',
}: EntityColorPickerProps) => {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const palette = boardEntityPalette(token);

  const apply = (color: string | null) => {
    setOpen(false);
    void onChange(color);
  };

  const swatch = (entry: { name: string; color: string }) => {
    const selected = value?.toLowerCase() === entry.color.toLowerCase();
    return (
      <Tooltip key={entry.name} title={entry.name}>
        <Button
          type="text"
          aria-label={entry.name}
          aria-pressed={selected}
          onClick={() => apply(entry.color)}
          style={{
            width: SWATCH_SIZE,
            height: SWATCH_SIZE,
            padding: 0,
            background: entry.color,
            borderRadius: token.borderRadiusSM,
            // A selected swatch gets a ring rather than a checkmark-only cue so
            // it stays readable against both light and dark swatch colors.
            boxShadow: selected ? `0 0 0 2px ${token.colorTextBase}` : undefined,
            color: token.colorWhite,
          }}
          icon={selected ? <CheckOutlined /> : undefined}
        />
      </Tooltip>
    );
  };

  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={setOpen}
      title="Color"
      rootClassName={REACT_FLOW_NO_DRAG_CLASS}
      content={
        <Space orientation="vertical" size="small" style={{ width: 240 }}>
          <Flex gap={token.marginXXS} wrap>
            {palette.map(swatch)}
          </Flex>
          <Flex justify="space-between" align="center" gap="small">
            <Button size="small" disabled={!value} onClick={() => apply(null)}>
              No color
            </Button>
            <ColorPicker
              value={value ?? null}
              format="hex"
              trigger="click"
              onChangeComplete={(color: Color) => apply(color.toHexString())}
            >
              <Button size="small">Custom…</Button>
            </ColorPicker>
          </Flex>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            Colors are yours to assign — group work or flag priority however you like.
          </Typography.Text>
        </Space>
      }
    >
      <Tooltip title={label}>
        <Button
          type="text"
          size="small"
          aria-label={label}
          disabled={disabled}
          className={REACT_FLOW_NO_DRAG_CLASS}
          onClick={(event) => event.stopPropagation()}
          icon={
            <BgColorsOutlined
              style={value ? { color: value } : undefined}
              // The icon alone is ambiguous once a color is set, so the
              // current color tints it; `aria-label` carries the meaning.
            />
          }
        />
      </Tooltip>
    </Popover>
  );
};

export default EntityColorPicker;
