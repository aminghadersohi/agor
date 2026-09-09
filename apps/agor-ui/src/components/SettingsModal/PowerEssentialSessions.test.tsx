import type { AgorClient, Session, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PowerEssentialSessions } from './PowerEssentialSessions';

const user = { user_id: 'fictional-admin', role: 'admin' } as User;

function fictionalSessions(count: number): Session[] {
  return Array.from({ length: count }, (_, index) => ({
    session_id: `018f0000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    title: `Fictional Session ${index + 1}`,
    power_priority: 'normal',
  })) as Session[];
}

function fixture(count: number) {
  const sessions = fictionalSessions(count);
  const find = vi.fn(async (params?: { query?: Record<string, unknown> }) => {
    if (params?.query?.power_priority === 'essential') return { data: [], total: 0 };
    const skip = Number(params?.query?.$skip ?? 0);
    const limit = Number(params?.query?.$limit ?? 50);
    return { data: sessions.slice(skip, skip + limit), total: sessions.length };
  });
  const service = { find, on: vi.fn(), off: vi.fn() };
  const client = { service: vi.fn(() => service) } as unknown as AgorClient;
  return { client, find };
}

describe('Power Essential Session paging', () => {
  it.each([
    ['no authorized Sessions', 0],
    ['one server page', 50],
  ])('does not render dead paging controls for %s', async (_case, count) => {
    const { client } = fixture(count);
    render(<PowerEssentialSessions client={client} user={user} />);

    expect(await screen.findByText(/No Essential Session is visible/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Authorized Sessions pages')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('1–0 of 0');
  });

  it('shows a compact accessible pager only for multiple bounded server pages', async () => {
    const { client, find } = fixture(51);
    render(<PowerEssentialSessions client={client} user={user} />);

    const pager = await screen.findByLabelText('Authorized Sessions pages');
    expect(pager).toBeInTheDocument();
    expect(screen.queryByText(/items per page/i)).not.toBeInTheDocument();

    const pageTwo = screen.getByTitle('2');
    pageTwo.focus();
    expect(pageTwo).toHaveFocus();
    fireEvent.click(pageTwo);

    await waitFor(() =>
      expect(find).toHaveBeenCalledWith({
        query: { $sort: { updated_at: -1 }, $limit: 50, $skip: 50 },
      })
    );
    expect(find.mock.calls.some(([params]) => params?.query?.$limit === 50)).toBe(true);
  });
});
