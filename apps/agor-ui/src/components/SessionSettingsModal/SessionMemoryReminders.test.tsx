import type { AgorClient } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
