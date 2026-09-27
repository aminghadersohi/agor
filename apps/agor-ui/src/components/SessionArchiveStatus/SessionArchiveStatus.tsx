import type { Session } from '@agor-live/client';
import { Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { archivedReasonLabel } from '../../utils/sessionArchive';
import { formatAbsoluteTime, formatTimeUntil } from '../../utils/time';

const TICK_MS = 15_000;

export interface SessionArchiveStatusProps {
  session: Pick<Session, 'archived' | 'archived_reason' | 'auto_archive_at'>;
}

/**
 * Why a session is archived, or when its pending automatic archival fires.
 * Renders nothing for an active session with no pending deadline.
 */
export function SessionArchiveStatus({ session }: SessionArchiveStatusProps) {
  const pendingAt = session.archived ? undefined : session.auto_archive_at;
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!pendingAt) return;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [pendingAt]);

  if (session.archived) {
    return (
      <Typography.Text type="secondary" data-testid="session-archive-status">
        {archivedReasonLabel(session.archived_reason)}
      </Typography.Text>
    );
  }
  const countdown = formatTimeUntil(pendingAt, now);
  if (!pendingAt || !countdown) return null;
  return (
    <Tooltip title={`Scheduled for ${formatAbsoluteTime(pendingAt)}. Prompting cancels it.`}>
      <Typography.Text type="secondary" data-testid="session-archive-status">
        Archives {countdown}
      </Typography.Text>
    </Tooltip>
  );
}
