import type { Branch, Schedule, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { HomeSchedulesSection } from './HomeSchedulesSection';

function schedule(id: string, name: string, branchId: string): Schedule {
  return {
    schedule_id: id,
    branch_id: branchId,
    name,
    cron_expression: '0 9 * * 1-5',
    timezone_mode: 'utc',
    prompt: 'Run the review',
    agentic_tool_config: { agentic_tool: 'codex' },
    enabled: true,
    allow_concurrent_runs: false,
    retention: 10,
    next_run_at: Date.now() + 60_000,
    created_at: '2026-08-25T00:00:00.000Z',
    updated_at: '2026-08-25T00:00:00.000Z',
    created_by: 'user-1',
  } as Schedule;
}

function clientWith(schedules: Schedule[], patch = vi.fn()) {
  const listeners = new Map<string, (schedule: Schedule) => void>();
  const scheduleService = {
    find: vi.fn().mockResolvedValue({ data: schedules }),
    on: vi.fn((event: string, callback: (value: Schedule) => void) =>
      listeners.set(event, callback)
    ),
    off: vi.fn(),
  };
  const userService = { patch };
  return {
    client: {
      service: (name: string) => (name === 'schedules' ? scheduleService : userService),
    } as never,
    patch,
    listeners,
  };
}

describe('HomeSchedulesSection', () => {
  beforeEach(() => {
    agorStore.setState({ ...EMPTY_MAPS });
  });

  it('renders trigger, worktree, and next-run nodes and opens the worktree', async () => {
    const schedules = [schedule('schedule-1', 'Daily review', 'branch-1')];
    const { client } = clientWith(schedules);
    const onBranchClick = vi.fn();
    agorStore.setState({
      userById: new Map([['user-1', { user_id: 'user-1', preferences: {} } as User]]),
      branchById: new Map([['branch-1', { branch_id: 'branch-1', name: 'release' } as Branch]]),
    });

    render(
      <App>
        <HomeSchedulesSection
          client={client}
          currentUserId="user-1"
          onBranchClick={onBranchClick}
        />
      </App>
    );

    expect(await screen.findByText('Daily review')).toBeVisible();
    expect(screen.getByText('Trigger')).toBeVisible();
    expect(screen.getByText('Worktree')).toBeVisible();
    expect(screen.getByText('Next run')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'release' }));
    expect(onBranchClick).toHaveBeenCalledWith('branch-1');
  });

  it('selects a subset without discarding unrelated user preferences', async () => {
    const schedules = [
      schedule('schedule-1', 'Daily review', 'branch-1'),
      schedule('schedule-2', 'Weekly report', 'branch-2'),
    ];
    const patch = vi.fn().mockResolvedValue({});
    const { client } = clientWith(schedules, patch);
    agorStore.setState({
      userById: new Map([
        [
          'user-1',
          {
            user_id: 'user-1',
            preferences: { audio: { enabled: true }, custom_setting: 'preserve-me' },
          } as unknown as User,
        ],
      ]),
      branchById: new Map([
        ['branch-1', { branch_id: 'branch-1', name: 'release' } as Branch],
        ['branch-2', { branch_id: 'branch-2', name: 'reports' } as Branch],
      ]),
    });

    render(
      <App>
        <HomeSchedulesSection client={client} currentUserId="user-1" />
      </App>
    );
    await screen.findByText('Daily review');
    fireEvent.click(screen.getByRole('button', { name: /Choose/ }));
    fireEvent.click(screen.getByText('Choose schedules'));
    const dialog = screen.getByRole('dialog', { name: 'Schedules on Home' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Weekly report/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(patch).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        preferences: expect.objectContaining({
          custom_setting: 'preserve-me',
          home_schedules: { mode: 'selected', schedule_ids: ['schedule-2'] },
        }),
      })
    );
  });

  it('applies live schedule patches without refetching the collection', async () => {
    const first = schedule('schedule-1', 'Daily review', 'branch-1');
    const { client, listeners } = clientWith([first]);
    agorStore.setState({
      userById: new Map([['user-1', { user_id: 'user-1', preferences: {} } as User]]),
      branchById: new Map([['branch-1', { branch_id: 'branch-1', name: 'release' } as Branch]]),
    });
    render(
      <App>
        <HomeSchedulesSection client={client} currentUserId="user-1" />
      </App>
    );
    await screen.findByText('Daily review');
    listeners.get('patched')?.({ ...first, name: 'Daily shipping review' });
    expect(await screen.findByText('Daily shipping review')).toBeVisible();
  });
});
