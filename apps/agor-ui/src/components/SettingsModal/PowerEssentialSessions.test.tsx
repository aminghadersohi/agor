import type {
  AgorClient,
  PowerEssentialSessionOption,
  PowerEssentialSessionSearchResult,
  User,
} from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PowerEssentialSessions } from './PowerEssentialSessions';

const user = { user_id: 'fictional-admin', role: 'admin' } as User;

function sessions(count: number, prefix = 'Recent'): PowerEssentialSessionOption[] {
  return Array.from({ length: count }, (_, index) => ({
    session_id: `018f0000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    title: `${prefix} Session ${index + 1}`,
    power_priority: 'normal',
  })) as PowerEssentialSessionOption[];
}

function fixture(find: (params?: unknown) => Promise<PowerEssentialSessionSearchResult>) {
  const picker = { find: vi.fn(find) };
  const sessionService = { on: vi.fn(), off: vi.fn() };
  const priority = {
    find: vi.fn(async () => ({
      session_id: sessions(1)[0].session_id,
      requested: 'normal',
      effective: false,
      can_manage: true,
      max_essential_sessions: 1,
    })),
    create: vi.fn(),
  };
  const client = {
    service: vi.fn((path: string) => {
      if (path === 'power-management/essential-sessions') return picker;
      if (path === 'sessions') return sessionService;
      return priority;
    }),
  } as unknown as AgorClient;
  return { client, picker };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Power Essential Session async picker', () => {
  it('shows one current selection separately and never renders the rejected pager', async () => {
    const selected = { ...sessions(1, 'Current')[0], power_priority: 'essential' as const };
    const { client, picker } = fixture(async () => ({
      data: sessions(30),
      limit: 30,
      selected,
      slot_occupied: true,
    }));
    render(<PowerEssentialSessions client={client} user={user} />);

    expect(await screen.findByText(/Current Session 1 .* Essential/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage current Session' })).toBeInTheDocument();
    expect(screen.getByText(/first 30 recent eligible Sessions/)).toBeInTheDocument();
    expect(picker.find).toHaveBeenCalledWith(undefined);
    expect(document.querySelector('.ant-pagination')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Authorized Sessions pages')).not.toBeInTheDocument();
  });

  it('debounces bounded server search without skip, counts, or hidden page traversal', async () => {
    const { client, picker } = fixture(async (params) => {
      const search = (params as { query?: { search?: string } } | undefined)?.query?.search;
      return {
        data: search ? sessions(1, search) : sessions(30),
        limit: 30,
        slot_occupied: false,
      };
    });
    render(<PowerEssentialSessions client={client} user={user} />);
    await screen.findByText('No Essential Session is selected.');

    const pickerInput = screen.getByRole('combobox', { name: 'Session to manage' });
    fireEvent.change(pickerInput, { target: { value: 'older fixture' } });
    expect(picker.find).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(picker.find).toHaveBeenCalledTimes(2));
    expect(picker.find).toHaveBeenLastCalledWith({ query: { search: 'older fixture' } });
    expect(JSON.stringify(picker.find.mock.calls)).not.toContain('$skip');
    expect(JSON.stringify(picker.find.mock.calls)).not.toContain('$limit');
    expect(document.querySelector('.ant-pagination')).not.toBeInTheDocument();
  });

  it('does not let a stale search overwrite the newer response', async () => {
    let resolveOld!: (value: PowerEssentialSessionSearchResult) => void;
    const old = new Promise<PowerEssentialSessionSearchResult>((resolve) => {
      resolveOld = resolve;
    });
    const { client } = fixture(async (params) => {
      const search = (params as { query?: { search?: string } } | undefined)?.query?.search;
      if (search === 'old') return old;
      if (search === 'new') {
        return { data: sessions(1, 'New result'), limit: 30, slot_occupied: false };
      }
      return { data: [], limit: 30, slot_occupied: false };
    });
    render(<PowerEssentialSessions client={client} user={user} />);
    await screen.findByText('No Essential Session is selected.');

    const pickerInput = screen.getByRole('combobox', { name: 'Session to manage' });
    fireEvent.change(pickerInput, { target: { value: 'old' } });
    await waitFor(() =>
      expect(client.service('power-management/essential-sessions').find).toHaveBeenCalledWith({
        query: { search: 'old' },
      })
    );
    fireEvent.change(pickerInput, { target: { value: 'new' } });
    await waitFor(() =>
      expect(client.service('power-management/essential-sessions').find).toHaveBeenCalledWith({
        query: { search: 'new' },
      })
    );

    fireEvent.mouseDown(pickerInput);
    expect(await screen.findByText(/New result Session 1/)).toBeInTheDocument();
    resolveOld({ data: sessions(1, 'Stale result'), limit: 30, slot_occupied: false });
    await act(async () => Promise.resolve());
    expect(screen.queryByText(/Stale result Session 1/)).not.toBeInTheDocument();
  });

  it('fails closed when the current slot is occupied but not eligible to display', async () => {
    const { client } = fixture(async () => ({ data: [], limit: 30, slot_occupied: true }));
    render(<PowerEssentialSessions client={client} user={user} />);
    expect(
      await screen.findByText(/exists but is archived, ineligible, or outside your Branch access/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Fictional|Hidden|Private/)).not.toBeInTheDocument();
  });
});
