import { type SessionID, shortId, type Task, type TaskID, type UserID } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { TaskAuditTags } from './TaskAuditTags';

const PARENT = '01900000-0000-7000-8000-0000000000aa' as SessionID;

const interruptedTask = {
  task_id: '01900000-0000-7000-8000-000000000001' as TaskID,
  metadata: {
    interruptions: [
      {
        requested_by_session_id: PARENT,
        requested_by_user_id: 'user-1' as UserID,
        relationship: 'parent' as const,
        target_task_id: '01900000-0000-7000-8000-000000000001' as TaskID,
        corrective_task_id: '01900000-0000-7000-8000-000000000002' as TaskID,
        idempotency_key: 'k',
        requested_at: '2026-09-27T12:00:00.000Z',
      },
    ],
  },
} as Pick<Task, 'task_id' | 'metadata'>;

describe('TaskAuditTags', () => {
  it('renders nothing when the task carries no audit', () => {
    const { container } = render(
      <TaskAuditTags task={{ task_id: 'task-1' as TaskID, metadata: undefined }} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an unloaded session as plain text outside the app shell', () => {
    const { container } = render(<TaskAuditTags task={interruptedTask} />);
    const tag = container.querySelector('[data-audit-tag="interrupted"]');
    expect(tag).toHaveTextContent(`Interrupted by ${shortId(PARENT)}`);
    expect(container.querySelector('a')).toBeNull();
  });

  it('opens the linked session through app actions', () => {
    const onSessionClick = vi.fn();
    render(
      <AppActionsProvider value={{ onSessionClick } as never}>
        <TaskAuditTags task={interruptedTask} />
      </AppActionsProvider>
    );
    fireEvent.click(screen.getByText(shortId(PARENT)));
    expect(onSessionClick).toHaveBeenCalledWith(PARENT);
  });
});
