import type { AgorClient, PowerManagementStatus } from '@agor-live/client';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PowerStatusBanner } from './PowerStatusBanner';

const status = (overrides: Partial<PowerManagementStatus> = {}): PowerManagementStatus => ({
  mode: 'enforce',
  state: 'normal',
  freshness: 'fresh',
  reason: 'online',
  transitioned_at: '2026-01-01T00:00:00.000Z',
  observation_age_ms: 500,
  would_hold: false,
  held: false,
  ...overrides,
});

describe('PowerStatusBanner', () => {
  it('reloads the redacted projection and updates every tab through realtime', async () => {
    let patched: ((next: PowerManagementStatus) => void) | undefined;
    const service = {
      find: vi.fn(async () => status({ mode: 'observe' })),
      on: vi.fn((_event: string, listener: (next: PowerManagementStatus) => void) => {
        patched = listener;
      }),
      off: vi.fn(),
    };
    const client = { service: () => service } as unknown as AgorClient;
    const { unmount } = render(<PowerStatusBanner client={client} />);
    expect(await screen.findByText(/UPS power policy normal \(Observe\)/)).toBeInTheDocument();
    expect(screen.getByText(/dispatch is not gated/i)).toBeInTheDocument();

    act(() => {
      patched?.(
        status({
          state: 'critical',
          reason: 'low_battery',
          would_hold: true,
          held: true,
        })
      );
    });
    expect(screen.getByText('UPS battery critical')).toBeInTheDocument();
    expect(screen.getByText(/Running work is not stopped/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/device|hostname|raw output/i);
    unmount();
    expect(service.off).toHaveBeenCalledWith('patched', expect.any(Function));
  });
});
