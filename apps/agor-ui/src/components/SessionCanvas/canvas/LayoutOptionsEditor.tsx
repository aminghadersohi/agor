import {
  type BoardLayoutSettings,
  boardLayoutTracks,
  normalizeBoardLayoutSettings,
} from '@agor/core/layout/board-layout-options';
import { Checkbox, InputNumber, Segmented, Select, Space, Switch, Typography, theme } from 'antd';
import { LayoutDensityControl } from './LayoutDensityControl';

export const CANVAS_LAYOUT_CONTROLS_CLASS = 'canvas-layout-controls';

interface LayoutOptionsEditorProps {
  value: BoardLayoutSettings;
  onChange: (value: BoardLayoutSettings) => void;
  itemCount: number;
  densityAvailable?: boolean;
  disabled?: boolean;
}

/** The single production editor used by Arrange Board and selected-item layout. */
export function LayoutOptionsEditor({
  value,
  onChange,
  itemCount,
  densityAvailable = true,
  disabled = false,
}: LayoutOptionsEditorProps) {
  const { token } = theme.useToken();
  const update = (patch: Partial<BoardLayoutSettings>) =>
    onChange(normalizeBoardLayoutSettings({ ...value, ...patch }, itemCount));
  const tracks = boardLayoutTracks(itemCount, value.trackAxis, value.trackCount);
  const gridDisabled = disabled || value.mode === 'compact';
  const packingDisabled = disabled || !value.packZoneContents;

  return (
    <Space orientation="vertical" size="small" style={{ width: 292 }}>
      <Segmented
        block
        aria-label="Layout mode"
        options={[
          { label: 'Grid', value: 'grid' },
          { label: 'Compact', value: 'compact' },
        ]}
        value={value.mode}
        disabled={disabled}
        onChange={(mode) => update({ mode: mode as BoardLayoutSettings['mode'] })}
      />
      <Typography.Text type="secondary">
        {value.mode === 'grid'
          ? 'Keeps stable rows and columns; alignment acts inside each cell.'
          : 'Packs a deterministic dense two-dimensional cluster.'}
      </Typography.Text>
      <LayoutDensityControl
        value={value.density}
        onChange={(density) => update({ density })}
        disabled={disabled || !densityAvailable || !value.packZoneContents}
        disabledReason={
          !value.packZoneContents
            ? 'Unavailable while Pack zone contents is off; no child presentation is changed.'
            : 'Unavailable because this scope has no worktrees or cards with body content.'
        }
      />
      <Space.Compact block>
        <Select
          aria-label="Grid tracks"
          value={value.trackAxis}
          disabled={gridDisabled}
          classNames={{ popup: { root: CANVAS_LAYOUT_CONTROLS_CLASS } }}
          options={[
            { label: 'Auto tracks', value: 'auto' },
            { label: 'Columns', value: 'columns' },
            { label: 'Rows', value: 'rows' },
          ]}
          onChange={(trackAxis) => update({ trackAxis })}
          style={{ width: '62%' }}
        />
        <InputNumber
          aria-label={
            value.trackAxis === 'rows'
              ? 'Number of rows'
              : value.trackAxis === 'columns'
                ? 'Number of columns'
                : 'Track count'
          }
          min={1}
          max={Math.max(1, itemCount)}
          value={value.trackCount}
          disabled={gridDisabled || value.trackAxis === 'auto'}
          onChange={(trackCount) => update({ trackCount: trackCount ?? 1 })}
          style={{ width: '38%' }}
        />
      </Space.Compact>
      {value.mode === 'grid' && value.trackAxis !== 'auto' && (
        <Typography.Text type="secondary">
          {tracks.columns} column{tracks.columns === 1 ? '' : 's'} × {tracks.rows} row
          {tracks.rows === 1 ? '' : 's'}
        </Typography.Text>
      )}
      <Space.Compact block>
        <Typography.Text
          style={{
            border: `1px solid ${token.colorBorder}`,
            borderInlineEnd: 0,
            borderRadius: `${token.borderRadius}px 0 0 ${token.borderRadius}px`,
            padding: '4px 11px',
          }}
        >
          Gap
        </Typography.Text>
        <InputNumber
          aria-label="Layout gap"
          min={0}
          step={1}
          value={value.gap}
          disabled={disabled}
          onChange={(gap) => update({ gap: gap ?? 0 })}
          style={{ flex: 1 }}
        />
      </Space.Compact>
      <Checkbox
        checked={value.packZoneContents}
        disabled={disabled}
        onChange={(event) => update({ packZoneContents: event.target.checked })}
      >
        Pack zone contents
      </Checkbox>
      <Checkbox
        checked={value.resizeZoneFrames}
        disabled={packingDisabled}
        onChange={(event) => update({ resizeZoneFrames: event.target.checked })}
      >
        Match / resize zone frames
      </Checkbox>
      <Checkbox
        checked={value.justifyRows}
        disabled={gridDisabled || packingDisabled || !value.resizeZoneFrames}
        onChange={(event) => update({ justifyRows: event.target.checked })}
      >
        Justify rows
      </Checkbox>
      <Select
        aria-label="Last row behavior"
        value={value.lastRow}
        disabled={gridDisabled}
        classNames={{ popup: { root: CANVAS_LAYOUT_CONTROLS_CLASS } }}
        options={[
          { label: 'Last row: left', value: 'start' },
          { label: 'Last row: centered', value: 'center' },
          { label: 'Last row: right', value: 'end' },
          {
            label: 'Last row: justify',
            value: 'justify',
            disabled: !value.packZoneContents || !value.resizeZoneFrames,
          },
        ]}
        onChange={(lastRow) => update({ lastRow })}
        style={{ width: '100%' }}
      />
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Typography.Text>Match heights within rows</Typography.Text>
        <Switch
          aria-label="Match heights within rows"
          checked={value.matchRowHeights}
          disabled={gridDisabled || !value.resizeZoneFrames}
          onChange={(matchRowHeights) => update({ matchRowHeights })}
        />
      </Space>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Typography.Text>Match widths within columns</Typography.Text>
        <Switch
          aria-label="Match widths within columns"
          checked={value.matchColumnWidths}
          disabled={gridDisabled || !value.resizeZoneFrames}
          onChange={(matchColumnWidths) => update({ matchColumnWidths })}
        />
      </Space>
    </Space>
  );
}
