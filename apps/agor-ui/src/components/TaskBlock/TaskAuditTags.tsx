import type { SessionID, Task } from '@agor-live/client';
import { shortId } from '@agor-live/client';
import { Tooltip, Typography } from 'antd';
import type React from 'react';
import { useMemo } from 'react';
import { useOptionalAppActions } from '../../contexts/AppActionsContext';
import { useAgorStore } from '../../store/agorStore';
import { makeSessionSelector } from '../../store/selectors';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { Tag } from '../Tag';
import { getTaskAuditTags } from './taskAudit';

const TAG_STYLE = { fontSize: 11 } as const;

/** One session subscription per link, not the whole map: many of these render per transcript. */
const SessionRef: React.FC<{ sessionId: SessionID }> = ({ sessionId }) => {
  const session = useAgorStore(useMemo(() => makeSessionSelector(sessionId), [sessionId]));
  const onSessionClick = useOptionalAppActions()?.onSessionClick;
  const title = session
    ? getSessionDisplayTitle(session, { includeAgentFallback: true, includeIdFallback: true })
    : shortId(sessionId);
  if (!onSessionClick) return <span>{title}</span>;
  return (
    <Typography.Link
      style={{ fontSize: 'inherit' }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSessionClick(sessionId);
      }}
    >
      {title}
    </Typography.Link>
  );
};

/** Origin and audit tags for one turn, derived from durable `task.metadata`. */
export const TaskAuditTags: React.FC<{ task: Pick<Task, 'task_id' | 'metadata'> }> = ({ task }) => {
  const tags = useMemo(() => getTaskAuditTags(task), [task]);
  return (
    <>
      {tags.map((tag) => {
        const element = (
          <Tag key={tag.key} color={tag.status} style={TAG_STYLE} data-audit-tag={tag.key}>
            {tag.label}
            {tag.session && (
              <>
                {' '}
                <SessionRef sessionId={tag.session} />
              </>
            )}
          </Tag>
        );
        return tag.tooltip ? (
          <Tooltip key={tag.key} title={tag.tooltip}>
            {element}
          </Tooltip>
        ) : (
          element
        );
      })}
    </>
  );
};
