import type { AgorClient, PowerAdmissionStatus } from '@agor-live/client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PowerHoldTag } from './PowerHoldTag';

const held: PowerAdmissionStatus = {
  held: true,
  state: 'conserve',
  reason: 'on_battery',
  transitioned_at: '2026-09-27T00:00:00.000Z',
};

function makeClient(initial: PowerAdmissionStatus) {
  const listeners = new Set<(data: PowerAdmissionStatus) => void>();
  const find = vi.fn(async () => initial);
  const paths: string[] = [];
  const client = {
    service(path: string) {
      paths.push(path);
      return {
        find,
        on: (_event: string, fn: (data: PowerAdmissionStatus) => void) => listeners.add(fn),
        off: (_event: string, fn: (data: PowerAdmissionStatus) => void) => listeners.delete(fn),
      };
    },
  } as unknown as AgorClient;
  const emit = (data: PowerAdmissionStatus) => {
    for (const fn of listeners) fn(data);
  };
  return { client, emit, paths };
}

describe('PowerHoldTag', () => {
  it('marks queued work held by the host power policy, reading only the redacted route', async () => {
    const { client, paths } = makeClient(held);
    render(<PowerHoldTag client={client} identityKey="user-1" queuedCount={2} />);

    expect(await screen.findByTestId('power-hold-tag')).toHaveTextContent(
      'Held by host power policy'
    );
    expect(new Set(paths)).toEqual(new Set(['power-management/admission']));
  });

  it('stays hidden with nothing queued', async () => {
    const { client } = makeClient(held);
    render(<PowerHoldTag client={client} identityKey="user-1" queuedCount={0} />);
    await waitFor(() => expect(screen.queryByTestId('power-hold-tag')).not.toBeInTheDocument());
  });

  it('does not mark the Essential session while conserving', async () => {
    const { client } = makeClient(held);
    render(
      <PowerHoldTag
        client={client}
        identityKey="user-1"
        powerPriority="essential"
        queuedCount={1}
      />
    );
    await waitFor(() => expect(screen.queryByTestId('power-hold-tag')).not.toBeInTheDocument());
  });

  it('clears live when a realtime transition releases the hold', async () => {
    const { client, emit } = makeClient(held);
    render(<PowerHoldTag client={client} identityKey="user-1" queuedCount={1} />);
    await screen.findByTestId('power-hold-tag');

    act(() => emit({ ...held, held: false, state: 'normal', reason: 'online' }));

    await waitFor(() => expect(screen.queryByTestId('power-hold-tag')).not.toBeInTheDocument());
  });
});
