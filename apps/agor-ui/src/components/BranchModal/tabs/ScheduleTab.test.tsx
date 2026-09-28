import type { AgorClient, Branch, Schedule, User } from '@agor-live/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBranch, renderWithApp } from '../testUtils';
import { ScheduleTab } from './ScheduleTab';

const scheduleModalProps = vi.hoisted(() => vi.fn());
vi.mock('../../ScheduleModal', () => ({
  ScheduleModal: (props: unknown) => {
    scheduleModalProps(props);
    return null;
  },
}));

vi.mock('../../ScheduleRunsPanel', () => ({
  ScheduleRunsPanel: () => null,
}));

const messages = vi.hoisted(() => ({
  showError: vi.fn(),
  showSuccess: vi.fn(),
  showWarning: vi.fn(),
}));
vi.mock('../../../utils/message', () => ({ useThemedMessage: () => messages }));

const makeSchedule = (overrides: Partial<Schedule> = {}): Schedule =>
  ({
    schedule_id: '018f0000-0000-7000-8000-000000000001',
    branch_id: 'branch-1',
    name: 'Very long customer escalation heartbeat title that should not stretch the modal',
    description: 'Long description that should stay tucked into the title cell and tooltip.',
    cron_expression: '0 8,12,16 * * 1-5',
    timezone_mode: 'local',
    timezone: 'America/Los_Angeles',
    prompt: 'Summarize the branch status.',
    agentic_tool_config: { agentic_tool: 'claude-code' },
    enabled: true,
    allow_concurrent_runs: false,
    retention: 5,
    last_run_at: 1_780_527_200_000,
    last_run_session_id: '018f0000-0000-7000-8000-0000000000aa',
    next_run_at: 1_780_530_800_000,
    created_at: '2026-06-04T00:00:00.000Z',
    updated_at: '2026-06-04T00:00:00.000Z',
    created_by: '018f0000-0000-7000-8000-0000000000bb',
    ...overrides,
  }) as Schedule;

const makeScheduleClient = (
  schedules: Schedule[],
  runNow: () => Promise<unknown> = async () => ({})
): AgorClient =>
  ({
    service(path: string) {
      if (path.endsWith('/run-now')) return { create: runNow };
      return {
        async find() {
          if (path === 'schedules') return { data: schedules };
          return [];
        },
        async patch() {
          return {};
        },
        async remove() {
          return {};
        },
        async create() {
          return {};
        },
        on() {},
        off() {},
      };
    },
  }) as unknown as AgorClient;

function renderScheduleTab({
  branch = makeBranch(),
  schedules = [makeSchedule()],
  onOpenSession = vi.fn(),
  currentUser,
  userById,
  runNow,
}: {
  branch?: Branch;
  schedules?: Schedule[];
  onOpenSession?: (sessionId: string) => void;
  currentUser?: User;
  userById?: Map<string, User>;
  runNow?: () => Promise<unknown>;
} = {}) {
  renderWithApp(
    <ScheduleTab
      branch={branch}
      client={makeScheduleClient(schedules, runNow)}
      onOpenSession={onOpenSession}
      currentUser={currentUser}
      userById={userById}
    />
  );
  return { onOpenSession };
}

describe('ScheduleTab compact list', () => {
  beforeEach(() => {
    scheduleModalProps.mockClear();
    for (const fn of Object.values(messages)) fn.mockClear();
  });

  it('keeps secondary schedule details out of full-width columns', async () => {
    renderScheduleTab();

    expect(await screen.findByRole('columnheader', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Next' })).toBeInTheDocument();

    expect(screen.queryByRole('columnheader', { name: /last run/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /scheduled by/i })).not.toBeInTheDocument();

    const title = screen.getByLabelText(/schedule title:/i);
    expect(title).toHaveStyle({ textOverflow: 'ellipsis', overflow: 'hidden' });
  });

  it('explains a power-held run-now as a host condition, not an error', async () => {
    const heldError = Object.assign(new Error('held'), { data: { code: 'schedule_power_held' } });
    renderScheduleTab({ runNow: vi.fn().mockRejectedValue(heldError) });

    fireEvent.click(await screen.findByRole('button', { name: /run schedule .* now/i }));

    await waitFor(() => {
      expect(messages.showWarning).toHaveBeenCalledWith(
        expect.stringContaining('host power policy is holding new work')
      );
    });
    expect(messages.showError).not.toHaveBeenCalled();
  });

  it('opens the last run from a row action', async () => {
    const { onOpenSession } = renderScheduleTab();

    const lastRunButton = await screen.findByRole('button', { name: /view last run/i });
    fireEvent.click(lastRunButton);

    await waitFor(() => {
      expect(onOpenSession).toHaveBeenCalledWith('018f0000-0000-7000-8000-0000000000aa');
    });
  });

  it.each([
    ['self-owned before user-map hydration', 'owner', undefined, 'owner'],
    ['different owner before user-map hydration', 'caller', undefined, null],
    ['different owner after user-map hydration', 'caller', 'owner', 'owner'],
  ])('passes %s to the editor', async (_label, callerId, hydratedOwnerId, expectedOwnerId) => {
    const caller = { user_id: callerId, email: `${callerId}@example.com` } as User;
    const owner = { user_id: 'owner', email: 'owner@example.com' } as User;
    renderScheduleTab({
      schedules: [makeSchedule({ created_by: owner.user_id })],
      currentUser: caller,
      userById: hydratedOwnerId ? new Map([[hydratedOwnerId, owner]]) : undefined,
    });

    fireEvent.click(await screen.findByRole('button', { name: /edit schedule/i }));

    expect(scheduleModalProps.mock.lastCall?.[0]).toMatchObject({
      executionOwner: expectedOwnerId ? owner : null,
    });
  });

  it('keeps a different-owner editor fail-closed for stale or caller-only user state', async () => {
    const caller = { user_id: 'caller', email: 'caller@example.com' } as User;
    const staleOwner = { user_id: 'stale-owner', email: 'stale@example.com' } as User;
    renderScheduleTab({
      schedules: [makeSchedule({ created_by: 'owner' })],
      currentUser: caller,
      userById: new Map([
        ['caller', caller],
        ['owner', staleOwner],
      ]),
    });

    fireEvent.click(await screen.findByRole('button', { name: /edit schedule/i }));

    expect(scheduleModalProps.mock.lastCall?.[0]).toMatchObject({ executionOwner: null });
  });
});
