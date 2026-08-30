import type {
  BoardEntityType,
  BoardPosition,
  ZoneLayoutPolicy,
  ZoneLayoutPreset,
  ZoneLayoutSortBy,
  ZoneLayoutSortDirection,
  ZoneOverflowStrategy,
  ZoneResizeMode,
} from '../types/board';
import { BOARD_GRID_SIZE, ceilBoardGridValue } from './rectangle-packing';

export const ZONE_LAYOUT_MODES = ['manual', 'auto'] as const;
export const ZONE_LAYOUT_PRESETS = ['grid', 'compact_list'] as const;
export const ZONE_LAYOUT_SORT_FIELDS = [
  'position',
  'priority',
  'status',
  'updated',
  'created',
  'title',
] as const;
export const ZONE_LAYOUT_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const ZONE_RESIZE_MODES = ['fixed', 'height', 'both'] as const;
export const ZONE_OVERFLOW_STRATEGIES = ['report', 'reflow_board'] as const;

export const DEFAULT_ZONE_LAYOUT_POLICY: Readonly<ZoneLayoutPolicy> = {
  mode: 'manual',
  preset: 'grid',
  sortBy: 'position',
  sortDirection: 'asc',
  autoResizeHeight: false,
  resize: 'fixed',
  onOverflow: 'report',
  gap: 24,
};

export const ZONE_LAYOUT_FRAME_PADDING = BOARD_GRID_SIZE;

export interface ZoneLayoutFrameInput {
  width: number;
  fontSize?: number;
  status?: string;
}

export interface ZoneLayoutFrame {
  /** Grid-aligned outer width used by the layout solver. */
  width: number;
  /** Equal left/right and bottom inset for every child entity type. */
  padding: number;
  /** Reserved title/status area before the first child. */
  headerInset: number;
  /** Width available to a full-width compact-list child. */
  usableWidth: number;
}

/**
 * One frame contract for every zone layout path and child entity type.
 *
 * The frame is intentionally independent of the card/worktree inside it:
 * layout configuration and zone metadata own its margins and title reserve.
 */
export function getZoneLayoutFrame(
  zone: ZoneLayoutFrameInput,
  options: { padding?: number } = {}
): ZoneLayoutFrame {
  const requestedPadding = options.padding ?? ZONE_LAYOUT_FRAME_PADDING;
  const padding =
    requestedPadding === 0
      ? 0
      : Math.max(BOARD_GRID_SIZE, ceilBoardGridValue(Math.max(0, requestedPadding)));
  const requestedWidth =
    Number.isFinite(zone.width) && zone.width > 0 ? zone.width : padding * 2 + BOARD_GRID_SIZE;
  const width = Math.max(padding * 2 + BOARD_GRID_SIZE, ceilBoardGridValue(requestedWidth));
  const labelFontSize =
    typeof zone.fontSize === 'number' && Number.isFinite(zone.fontSize)
      ? Math.min(48, Math.max(10, zone.fontSize))
      : 14;
  const labelHeight = Math.ceil(labelFontSize * 1.2);
  const statusHeight = zone.status ? 8 + Math.ceil(labelFontSize * 1.05) : 0;
  const headerInset = ceilBoardGridValue(Math.max(64, 32 + labelHeight + statusHeight));

  return {
    width,
    padding,
    headerInset,
    usableWidth: width - padding * 2,
  };
}

/** Compact-list children share the frame width; only their content height differs. */
export function compactZoneItemSize(
  entityType: BoardEntityType,
  usableWidth: number
): { width: number; height: number } {
  return {
    width: usableWidth,
    height: entityType === 'branch' ? BOARD_GRID_SIZE * 5 : BOARD_GRID_SIZE * 3,
  };
}

export interface ZoneLayoutSortItem {
  id: string;
  position: BoardPosition;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Numeric ranks sort naturally; lower values represent higher priority. */
  rank?: number;
  /** Common workflow labels such as urgent, high, blocked, done, or archived. */
  priority?: unknown;
  status?: unknown;
}

const isOneOf = <T extends string>(value: unknown, values: readonly T[]): value is T =>
  typeof value === 'string' && values.includes(value as T);

export function normalizeZoneLayoutPolicy(
  policy: Partial<ZoneLayoutPolicy> | undefined
): ZoneLayoutPolicy {
  const preset: ZoneLayoutPreset = isOneOf(policy?.preset, ZONE_LAYOUT_PRESETS)
    ? policy.preset
    : DEFAULT_ZONE_LAYOUT_POLICY.preset;
  const sortBy: ZoneLayoutSortBy = isOneOf(policy?.sortBy, ZONE_LAYOUT_SORT_FIELDS)
    ? policy.sortBy
    : DEFAULT_ZONE_LAYOUT_POLICY.sortBy;
  const sortDirection: ZoneLayoutSortDirection = isOneOf(
    policy?.sortDirection,
    ZONE_LAYOUT_SORT_DIRECTIONS
  )
    ? policy.sortDirection
    : DEFAULT_ZONE_LAYOUT_POLICY.sortDirection;
  const columns =
    Number.isFinite(policy?.columns) && (policy?.columns ?? 0) > 0
      ? Math.max(1, Math.floor(policy?.columns ?? 1))
      : undefined;
  const gap = Number.isFinite(policy?.gap)
    ? Math.min(96, Math.max(0, Math.round(policy?.gap ?? 24)))
    : DEFAULT_ZONE_LAYOUT_POLICY.gap;

  // `resize` supersedes the `autoResizeHeight` boolean. Reconciling them here,
  // once, is what keeps every caller from having to know both spellings: an
  // explicit `resize` wins, an old policy is read through its boolean, and both
  // are always written back so a reader predating `resize` still behaves.
  const resize: ZoneResizeMode = isOneOf(policy?.resize, ZONE_RESIZE_MODES)
    ? policy.resize
    : policy?.autoResizeHeight === true
      ? 'height'
      : 'fixed';
  const onOverflow: ZoneOverflowStrategy = isOneOf(policy?.onOverflow, ZONE_OVERFLOW_STRATEGIES)
    ? policy.onOverflow
    : 'report';

  return {
    mode: isOneOf(policy?.mode, ZONE_LAYOUT_MODES) ? policy.mode : DEFAULT_ZONE_LAYOUT_POLICY.mode,
    preset,
    sortBy,
    sortDirection,
    ...(columns === undefined ? {} : { columns }),
    gap,
    resize,
    onOverflow,
    autoResizeHeight: resize !== 'fixed',
  };
}

const PRIORITY_RANKS: Readonly<Record<string, number>> = {
  urgent: 0,
  critical: 0,
  highest: 0,
  high: 1,
  blocked: 1,
  medium: 2,
  normal: 2,
  low: 3,
  lowest: 4,
  done: 5,
  completed: 5,
  archived: 6,
};

const STATUS_RANKS: Readonly<Record<string, number>> = {
  urgent: 0,
  blocked: 1,
  failed: 1,
  error: 1,
  // Branch filesystem lifecycle values. Keep these here alongside workflow
  // statuses because branch and card placements share the public status sort.
  creating: 2,
  running: 2,
  active: 2,
  ready: 3,
  todo: 3,
  open: 3,
  pending: 3,
  review: 4,
  preserved: 4,
  done: 5,
  completed: 5,
  closed: 5,
  cleaned: 5,
  archived: 6,
  deleted: 6,
};

function normalizedLabel(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
}

function semanticRank(value: unknown, ranks: Readonly<Record<string, number>>): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const label = normalizedLabel(value);
  if (!label) return Number.POSITIVE_INFINITY;
  return ranks[label] ?? 50;
}

function timestamp(value: string | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function compareNumber(a: number, b: number): number {
  if (a === b) return 0;
  if (!Number.isFinite(a)) return 1;
  if (!Number.isFinite(b)) return -1;
  return a - b;
}

function compareText(a: unknown, b: unknown): number {
  const left = normalizedLabel(a);
  const right = normalizedLabel(b);
  if (!left && right) return 1;
  if (left && !right) return -1;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function compareField(a: ZoneLayoutSortItem, b: ZoneLayoutSortItem, sortBy: ZoneLayoutSortBy) {
  switch (sortBy) {
    case 'position':
      return a.position.y - b.position.y || a.position.x - b.position.x;
    case 'priority':
      return compareNumber(
        a.rank ?? semanticRank(a.priority, PRIORITY_RANKS),
        b.rank ?? semanticRank(b.priority, PRIORITY_RANKS)
      );
    case 'status':
      return (
        compareNumber(semanticRank(a.status, STATUS_RANKS), semanticRank(b.status, STATUS_RANKS)) ||
        compareText(a.status, b.status)
      );
    case 'updated':
      return compareNumber(timestamp(a.updatedAt), timestamp(b.updatedAt));
    case 'created':
      return compareNumber(timestamp(a.createdAt), timestamp(b.createdAt));
    case 'title':
      return compareText(a.title, b.title);
  }
}

function isMissingSortValue(item: ZoneLayoutSortItem, sortBy: ZoneLayoutSortBy): boolean {
  if (sortBy === 'priority') {
    if (item.rank !== undefined && Number.isFinite(item.rank)) return false;
    const label = normalizedLabel(item.priority);
    return !label || !(label in PRIORITY_RANKS);
  }
  if (sortBy === 'status') {
    const label = normalizedLabel(item.status);
    return !label || !(label in STATUS_RANKS);
  }
  if (sortBy === 'updated') return !Number.isFinite(Date.parse(item.updatedAt ?? ''));
  if (sortBy === 'created') return !Number.isFinite(Date.parse(item.createdAt ?? ''));
  if (sortBy === 'title') return !normalizedLabel(item.title);
  return false;
}

/** Deterministically order zone items while keeping missing metadata at the end. */
export function sortZoneLayoutItems<T extends ZoneLayoutSortItem>(
  items: readonly T[],
  policy: Pick<ZoneLayoutPolicy, 'sortBy' | 'sortDirection'>
): T[] {
  const direction = policy.sortDirection === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const comparison = compareField(a, b, policy.sortBy);
    // Missing values remain last in both directions instead of jumping to the
    // front when descending order is requested.
    const aMissing = isMissingSortValue(a, policy.sortBy);
    const bMissing = isMissingSortValue(b, policy.sortBy);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    return comparison * direction || a.id.localeCompare(b.id);
  });
}
