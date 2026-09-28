import type { Session } from '@agor-live/client';

const ARCHIVED_REASON_LABELS: Record<NonNullable<Session['archived_reason']>, string> = {
  manual: 'Archived manually',
  branch_archived: 'Archived with its branch',
  parent_archived: 'Archived with its parent session',
  btw_completed: 'Archived after its btw answer was delivered',
  auto_completed: 'Archived automatically after completion',
};

/** Human label for why a session is archived; generic when the reason is unknown. */
export function archivedReasonLabel(reason: Session['archived_reason']): string {
  return (reason && ARCHIVED_REASON_LABELS[reason]) ?? 'Archived';
}
