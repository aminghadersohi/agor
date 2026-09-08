import type { AgorClient, PowerManagementStatus, User } from '@agor-live/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PowerStatusIndicator, powerStatusLabel } from './PowerStatusIndicator';

const status = (overrides: Partial<PowerManagementStatus> = {}): PowerManagementStatus => ({
  mode: 'enforce',
  state: 'normal',
  freshness: 'fresh',
  reason: 'online',
  transitioned_at: '2026-01-01T00:00:00.000Z',
  would_hold: false,
  held: false,
  ...overrides,
});
const admin = { user_id: 'fictional-admin', role: 'admin' } as User;
function Location() {
  return <output>{useLocation().pathname}</output>;
}
function fixture(find = vi.fn(async () => status())) {
  const service = { find, on: vi.fn(), off: vi.fn() };
  const client = { service: vi.fn(() => service) } as unknown as AgorClient;
  return { service, client };
}
afterEach(() => vi.useRealTimers());
describe('UPS header indicator', () => {
  it.each([
    [{ mode: 'off', state: 'disabled', freshness: 'unavailable' }, 'OFF'],
    [{}, 'ONLINE'],
    [{ state: 'conserve' }, 'CONSERVE'],
    [{ state: 'critical' }, 'CRITICAL'],
    [{ state: 'recovering' }, 'RECOVERY'],
    [{ recovery_pacing: true }, 'RECOVERY'],
    [{ freshness: 'stale' }, 'ERROR'],
    [{ state: 'unknown' }, 'ERROR'],
  ] as Array<[Partial<PowerManagementStatus>, string]>)(
    'labels %j accessibly as %s',
    (value, expected) => {
      expect(powerStatusLabel(status(value), false).label).toBe(expected);
    }
  );
  it('never reads host telemetry for a member', () => {
    const { client } = fixture();
    render(
      <MemoryRouter>
        <PowerStatusIndicator client={client} user={{ ...admin, role: 'member' }} />
      </MemoryRouter>
    );
    expect(client.service).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('navigates to UPS settings and refreshes unchanged samples by polling', async () => {
    vi.useFakeTimers();
    const { client, service } = fixture();
    const view = render(
      <MemoryRouter>
        <PowerStatusIndicator client={client} user={admin} />
        <Location />
      </MemoryRouter>
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'UPS ONLINE' }));
    expect(screen.getByText('/settings/power/')).toBeInTheDocument();
    service.find.mockResolvedValue(
      status({ state: 'conserve', mode: 'observe', would_hold: true })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole('button', { name: 'UPS CONSERVE · Observe' })).toBeInTheDocument();
    service.find.mockRejectedValue(new Error('private backend details'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole('button', { name: 'UPS ERROR' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('private backend details');
    view.unmount();
    expect(service.off).toHaveBeenCalledWith('patched', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('expires a hung refresh instead of displaying a healthy reading indefinitely', async () => {
    vi.useFakeTimers();
    const { client, service } = fixture();
    const rendered = render(
      <MemoryRouter>
        <PowerStatusIndicator client={client} user={admin} />
      </MemoryRouter>
    );
    await act(async () => {});
    service.find.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(screen.getByRole('button', { name: 'UPS ERROR' })).toBeInTheDocument();
    rendered.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('discards an old admin response after identity replacement', async () => {
    let complete!: (value: PowerManagementStatus) => void;
    const { client, service } = fixture(
      vi.fn(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          })
      )
    );
    const view = (user: User) => (
      <MemoryRouter>
        <PowerStatusIndicator client={client} user={user} />
      </MemoryRouter>
    );
    const rendered = render(view(admin));
    const oldComplete = complete;
    service.find.mockResolvedValue(status({ mode: 'off', state: 'disabled' }));
    rendered.rerender(view({ ...admin, user_id: 'fictional-admin-b' } as User));
    await act(async () => {
      oldComplete(status({ state: 'critical' }));
    });
    expect(screen.getByRole('button', { name: 'UPS OFF' })).toBeInTheDocument();
  });
});
