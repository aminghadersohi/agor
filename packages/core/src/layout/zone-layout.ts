import type {
  BoardPosition,
  ZoneLayoutPolicy,
  ZoneLayoutPreset,
  ZoneLayoutSortBy,
  ZoneLayoutSortDirection,
} from '../types/board';

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

export const DEFAULT_ZONE_LAYOUT_POLICY: Readonly<ZoneLayoutPolicy> = {
  mode: 'manual',
  preset: 'grid',
  sortBy: 'position',
  sortDirection: 'asc',
  autoResizeHeight: false,
  gap: 24,
};

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

  return {
    mode: isOneOf(policy?.mode, ZONE_LAYOUT_MODES) ? policy.mode : DEFAULT_ZONE_LAYOUT_POLICY.mode,
    preset,
    sortBy,
    sortDirection,
    ...(columns === undefined ? {} : { columns }),
    gap,
    autoResizeHeight: policy?.autoResizeHeight === true,
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
  running: 2,
  active: 2,
  todo: 3,
  open: 3,
  pending: 3,
  review: 4,
  done: 5,
  completed: 5,
  closed: 5,
  archived: 6,
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
