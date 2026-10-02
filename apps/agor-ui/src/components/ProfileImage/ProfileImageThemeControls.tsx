import { normalizeProfileImageTheme, PROFILE_IMAGE_THEME_MAX_LENGTH } from '@agor-live/client';
import { AutoComplete, Flex, Tag, Typography, theme } from 'antd';
import { useMemo } from 'react';

interface ProfileImageThemeInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Themes already used in this gallery, offered as completions. */
  themes: string[];
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  /** Fired on Enter or when a suggestion is picked. */
  onCommit?: (value: string) => void;
  onBlur?: () => void;
  style?: React.CSSProperties;
}

/** Free-text theme field that completes from the gallery's existing themes. */
export function ProfileImageThemeInput({
  value,
  onChange,
  themes,
  placeholder = 'Theme (e.g. Winter)',
  ariaLabel,
  disabled,
  onCommit,
  onBlur,
  style,
}: ProfileImageThemeInputProps) {
  const options = useMemo(() => {
    const query = value.trim().toLocaleLowerCase();
    return themes
      .filter((candidate) => !query || candidate.toLocaleLowerCase().includes(query))
      .map((candidate) => ({ value: candidate }));
  }, [themes, value]);

  return (
    <AutoComplete
      value={value}
      options={options}
      onChange={(next) => onChange(next ?? '')}
      onSelect={(next) => onCommit?.(next)}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onCommit?.(value);
      }}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={PROFILE_IMAGE_THEME_MAX_LENGTH}
      aria-label={ariaLabel}
      allowClear
      style={{ minWidth: 160, ...style }}
    />
  );
}

interface ProfileImageThemePickerProps {
  themes: string[];
  counts: Map<string, number>;
  total: number;
  /** The persisted active theme, or undefined for "All". */
  activeTheme?: string;
  canEdit: boolean;
  busy: boolean;
  onSelect: (theme: string | null) => void;
}

/** Chips that choose which theme every photo surface shows for this teammate. */
export function ProfileImageThemePicker({
  themes,
  counts,
  total,
  activeTheme,
  canEdit,
  busy,
  onSelect,
}: ProfileImageThemePickerProps) {
  const { token } = theme.useToken();
  const activeKey = normalizeProfileImageTheme(activeTheme)?.toLocaleLowerCase();
  const activeCount = activeKey ? (counts.get(activeKey) ?? 0) : 0;
  // A stored theme whose images are gone stays visible so it can be left.
  const chips = useMemo(() => {
    const keys = new Set(themes.map((candidate) => candidate.toLocaleLowerCase()));
    const stale = normalizeProfileImageTheme(activeTheme);
    return stale && !keys.has(stale.toLocaleLowerCase()) ? [...themes, stale] : themes;
  }, [activeTheme, themes]);

  return (
    <Flex vertical gap={token.marginXXS} data-testid="profile-image-theme-picker">
      <Typography.Text strong>Theme shown everywhere</Typography.Text>
      <Flex wrap gap={token.marginXXS} role="group" aria-label="Active photo theme">
        <Tag.CheckableTag checked={!activeKey} onChange={() => canEdit && !busy && onSelect(null)}>
          All ({total})
        </Tag.CheckableTag>
        {chips.map((candidate) => {
          const key = candidate.toLocaleLowerCase();
          return (
            <Tag.CheckableTag
              key={key}
              checked={key === activeKey}
              onChange={(checked) => canEdit && !busy && onSelect(checked ? candidate : null)}
            >
              {candidate} ({counts.get(key) ?? 0})
            </Tag.CheckableTag>
          );
        })}
      </Flex>
      <Typography.Text type="secondary">
        {!activeKey
          ? 'Every photo is used. Label photos with a theme, then pick one here to show only those.'
          : activeCount === 0
            ? `No photos use “${normalizeProfileImageTheme(activeTheme)}”, so every photo is used.`
            : `Only the ${activeCount} “${normalizeProfileImageTheme(activeTheme)}” photo${activeCount === 1 ? '' : 's'} appear on avatars, board tiles, and the screensaver.`}
      </Typography.Text>
    </Flex>
  );
}
