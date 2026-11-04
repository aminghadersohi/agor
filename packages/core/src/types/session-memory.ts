import type { SessionID, SessionMemoryID, SessionReminderID, TaskID, UserID } from './id';

export const SESSION_MEMORY_MAX_TEXT_BYTES = 8 * 1024;
export const SESSION_MEMORY_MAX_TITLE_CHARS = 120;
export const SESSION_MEMORY_MAX_TAGS = 8;
export const SESSION_MEMORY_MAX_TAG_CHARS = 32;
export const SESSION_MEMORY_MAX_ROWS_PER_SESSION = 5_000;
export const SESSION_MEMORY_DEFAULT_LIMIT = 25;
export const SESSION_MEMORY_MAX_LIMIT = 100;

export interface SessionMemory {
  memory_id: SessionMemoryID;
  session_id: SessionID;
  title?: string;
  text: string;
  tags: string[];
  archived: boolean;
  created_by: UserID;
  created_at: string;
  updated_at: string;
  revision: number;
}

export interface SessionMemoryCreateData {
  session_id: SessionID;
  title?: string;
  text: string;
  tags?: string[];
}

export interface SessionMemoryPatchData {
  /** Required parent scope; prevents ID-only cross-Session mutation. */
  session_id: SessionID;
  expected_revision: number;
  title?: string | null;
  text?: string;
  tags?: string[];
  archived?: boolean;
}

export const SESSION_REMINDER_STATUSES = [
  'scheduled',
  'claimed',
  'queued',
  'cancelled',
  'blocked',
] as const;
export type SessionReminderStatus = (typeof SESSION_REMINDER_STATUSES)[number];

export const SESSION_REMINDER_MAX_TEXT_BYTES = 4 * 1024;
export const SESSION_REMINDER_MAX_SCHEDULED_PER_SESSION = 100;
export const SESSION_REMINDER_MIN_LEAD_MS = 60_000;
export const SESSION_REMINDER_MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1_000;
export const SESSION_REMINDER_DEFAULT_LIMIT = 50;
export const SESSION_REMINDER_MAX_LIMIT = 100;

/**
 * Optional wake condition: a conditional reminder fires as soon as the
 * condition is observed, or at `due_at` (its hard deadline) if it never is.
 */
export const SESSION_REMINDER_WAKE_PR_STATES = ['merged', 'closed'] as const;
export type SessionReminderWakePrState = (typeof SESSION_REMINDER_WAKE_PR_STATES)[number];

export interface SessionReminderWakeCondition {
  kind: 'github_pr';
  /** `owner/name` of a GitHub repository. */
  repo: string;
  number: number;
  /** `closed` is also satisfied by a merge (a merged PR is closed). */
  state: SessionReminderWakePrState;
}

export const SESSION_REMINDER_DEFAULT_CHECK_EVERY_MINUTES = 10;
export const SESSION_REMINDER_MIN_CHECK_EVERY_MINUTES = 5;
export const SESSION_REMINDER_MAX_CHECK_EVERY_MINUTES = 60;

export type SessionReminderFailureCode =
  | 'session_archived'
  | 'branch_archived'
  | 'branch_unavailable'
  | 'authorization_revoked'
  | 'session_missing'
  | 'dispatch_failed'
  | 'retries_exhausted';

export interface SessionReminder {
  reminder_id: SessionReminderID;
  session_id: SessionID;
  text: string;
  /** Canonical UTC instant; always serialized with a trailing Z. */
  due_at: string;
  /** IANA display timezone captured when the reminder was authored. */
  display_timezone: string;
  status: SessionReminderStatus;
  created_by: UserID;
  created_at: string;
  updated_at: string;
  revision: number;
  claimed_at?: string;
  claim_expires_at?: string;
  attempt_count: number;
  queued_at?: string;
  task_id?: TaskID;
  failure_code?: SessionReminderFailureCode;
  /** Present only on conditional reminders; `due_at` is then the deadline. */
  wake_when?: SessionReminderWakeCondition;
  check_every_minutes?: number;
  /** Next condition check while scheduled; cleared once an outcome is recorded. */
  next_check_at?: string;
  /** Observed outcome appended to the queued prompt, fixed before dispatch. */
  wake_outcome?: string;
}

export interface SessionReminderCreateData {
  session_id: SessionID;
  text: string;
  due_at: string;
  display_timezone: string;
  wake_when?: SessionReminderWakeCondition;
  check_every_minutes?: number;
}

export interface SessionReminderPatchData {
  /** Required parent scope; prevents ID-only cross-Session mutation. */
  session_id: SessionID;
  expected_revision: number;
  text?: string;
  due_at?: string;
  display_timezone?: string;
  /** `null` removes the wake condition, making this a time-only reminder. */
  wake_when?: SessionReminderWakeCondition | null;
  check_every_minutes?: number;
  cancel?: boolean;
}

export class SessionMemoryRevisionConflictError extends Error {
  readonly code = 'session_memory_revision_conflict';
  constructor() {
    super('This memory changed in another tab or tool call. Reload it and try again.');
    this.name = 'SessionMemoryRevisionConflictError';
  }
}

export class SessionReminderRevisionConflictError extends Error {
  readonly code = 'session_reminder_revision_conflict';
  constructor() {
    super('This reminder changed or was already claimed. Reload it and try again.');
    this.name = 'SessionReminderRevisionConflictError';
  }
}
