import type { AgorClient, SessionMemory, SessionReminder } from '@agor-live/client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionMemoryReminders } from './SessionMemoryReminders';

function clientFixture() {
  const memory = {
    find: vi.fn().mockResolvedValue({ total: 0, limit: 25, skip: 0, data: [] }),
    create: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    on: vi.fn(),
    off: vi.fn(),
  };
  const reminders = {
    find: vi.fn().mockResolvedValue({ total: 0, limit: 50, skip: 0, data: [] }),
    create: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    on: vi.fn(),
    off: vi.fn(),
  };
  const client = {
    service: vi.fn((path: string) => (path === 'session-memories' ? memory : reminders)),
  } as unknown as AgorClient;
  return { client, memory, reminders };
}

const SESSION_ID = '019f0000-0000-7000-8000-000000000001';

function memoryRow(index: number, overrides: Partial<SessionMemory> = {}): SessionMemory {
  return {
    memory_id: `019f0000-0000-7000-8000-1000000000${String(index).padStart(2, '0')}`,
    session_id: SESSION_ID,
    title: `Memory ${index}`,
    text: `Fact ${index}`,
    tags: [],
    archived: false,
    created_by: '019f0000-0000-7000-8000-000000000009',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    revision: 1,
    ...overrides,
  } as SessionMemory;
}

function renderSurface(client: AgorClient) {
  return render(
    <SessionMemoryReminders client={client} sessionId={SESSION_ID} sessionArchived={false} />
  );
}

describe('SessionMemoryReminders', () => {
  it('scopes memory creation to the current Session and explains privacy', async () => {
    const fixture = clientFixture();
    render(
      <SessionMemoryReminders
        client={fixture.client}
        sessionId="019f0000-0000-7000-8000-000000000001"
        sessionArchived={false}
      />
    );
    expect(await screen.findByText(/Shared Knowledge requires an explicit/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New Session memory'), {
      target: { value: 'Use the fictional amber protocol.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Remember/i }));
    await waitFor(() =>
      expect(fixture.memory.create).toHaveBeenCalledWith({
        session_id: '019f0000-0000-7000-8000-000000000001',
        text: 'Use the fictional amber protocol.',
      })
    );
  });

  it('keeps archived Session reminders inspectable but disables new scheduling', async () => {
    const fixture = clientFixture();
    render(
      <SessionMemoryReminders
        client={fixture.client}
        sessionId="019f0000-0000-7000-8000-000000000001"
        sessionArchived
      />
    );
    fireEvent.click(await screen.findByText('Reminders'));
    expect(screen.getByText(/restore it before scheduling/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Reminder prompt')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Schedule one-shot reminder/i })).toBeDisabled();
  });

  it('lists archived memories on request and restores them', async () => {
    const fixture = clientFixture();
    const archived = memoryRow(1, { archived: true, revision: 3 });
    fixture.memory.find.mockImplementation(async ({ query }) =>
      query.archived === false
        ? { total: 0, limit: 25, skip: 0, data: [] }
        : { total: 1, limit: 25, skip: 0, data: [archived] }
    );
    renderSurface(fixture.client);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Show archived' }));
    await screen.findByText('Archived');
    expect(fixture.memory.find).toHaveBeenLastCalledWith({
      query: expect.not.objectContaining({ archived: expect.anything() }),
    });
    expect(screen.queryByRole('button', { name: 'Archive memory' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore memory' }));
    await waitFor(() =>
      expect(fixture.memory.patch).toHaveBeenCalledWith(archived.memory_id, {
        session_id: SESSION_ID,
        expected_revision: 3,
        archived: false,
      })
    );
  });

  it('sends normalized tags with a new memory', async () => {
    const fixture = clientFixture();
    renderSurface(fixture.client);
    fireEvent.change(await screen.findByLabelText('New Session memory'), {
      target: { value: 'Tagged fact' },
    });
    const tags = screen.getByRole('combobox', { name: 'Memory tags' });
    fireEvent.change(tags, { target: { value: 'Deploy,' } });
    fireEvent.click(screen.getByRole('button', { name: /Remember/i }));
    await waitFor(() =>
      expect(fixture.memory.create).toHaveBeenCalledWith({
        session_id: SESSION_ID,
        text: 'Tagged fact',
        tags: ['deploy'],
      })
    );
  });

  it('loads further memory pages with $skip until the total is reached', async () => {
    const fixture = clientFixture();
    const firstPage = Array.from({ length: 25 }, (_, index) => memoryRow(index));
    fixture.memory.find.mockImplementation(async ({ query }) =>
      query.$skip === 25
        ? { total: 26, limit: 25, skip: 25, data: [memoryRow(25)] }
        : { total: 26, limit: 25, skip: 0, data: firstPage }
    );
    renderSurface(fixture.client);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more memories' }));
    expect(await screen.findByText('Memory 25')).toBeInTheDocument();
    expect(fixture.memory.find).toHaveBeenLastCalledWith({
      query: expect.objectContaining({ session_id: SESSION_ID, archived: false, $skip: 25 }),
    });
    expect(screen.getByText('Memory 0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more memories' })).not.toBeInTheDocument();
  });

  it('explains blocked reminders and shows the dispatched task reference', async () => {
    const fixture = clientFixture();
    const base = {
      session_id: SESSION_ID,
      due_at: '2026-09-01T12:00:00.000Z',
      display_timezone: 'UTC',
      created_by: '019f0000-0000-7000-8000-000000000009',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
      revision: 2,
      attempt_count: 1,
    };
    const rows = [
      {
        ...base,
        reminder_id: '019f0000-0000-7000-8000-200000000001',
        text: 'Blocked follow-up',
        status: 'blocked',
        failure_code: 'branch_archived',
      },
      {
        ...base,
        reminder_id: '019f0000-0000-7000-8000-200000000002',
        text: 'Queued follow-up',
        status: 'queued',
        task_id: '019f1234-0000-7000-8000-300000000001',
      },
    ] as SessionReminder[];
    fixture.reminders.find.mockResolvedValue({ total: 2, limit: 50, skip: 0, data: rows });
    renderSurface(fixture.client);
    fireEvent.click(await screen.findByText('Reminders'));
    const blocked = (await screen.findByText('Blocked follow-up')).closest('li') as HTMLElement;
    expect(within(blocked).getByText('branch_archived')).toBeInTheDocument();
    expect(within(blocked).getByText(/branch was archived/i)).toBeInTheDocument();
    const queued = screen.getByText('Queued follow-up').closest('li') as HTMLElement;
    expect(within(queued).getByText('019f12340000700080003000')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more reminders' })).not.toBeInTheDocument();
  });
});
