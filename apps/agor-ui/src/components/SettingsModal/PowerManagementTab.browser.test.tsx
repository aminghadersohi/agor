import type { AgorClient, PowerManagementStatus, Session, User } from '@agor-live/client';
import {
  powerManagementSettingsFromResolved,
  resolvePowerManagementConfig,
} from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { MobileHeader, MobileHeaderAccessory } from '../mobile/MobileHeader';
import { PowerStatusIndicator } from '../PowerStatusIndicator';
import { PowerManagementTab } from './PowerManagementTab';

const user = { user_id: 'fictional-admin', role: 'admin' } as User;
const session = {
  session_id: '018f0000-0000-7000-8000-000000000001',
  title: 'Demo outage checklist',
  power_priority: 'essential',
} as Session;
const status: PowerManagementStatus = {
  mode: 'observe',
  state: 'conserve',
  freshness: 'fresh',
  reason: 'on_battery',
  transitioned_at: '2026-01-01T00:00:00.000Z',
  would_hold: true,
  held: false,
  configuration: powerManagementSettingsFromResolved(
    resolvePowerManagementConfig({ mode: 'observe' })
  ),
  observation: {
    condition: 'battery',
    communication: 'ok',
    charge_percent: 72,
    runtime_seconds: 1200,
    observed_at: '2026-01-01T00:00:01.000Z',
  },
};

describe('UPS admin workspace (browser)', () => {
  it('keeps a critical Observe indicator visible in the mobile header with long page titles', async () => {
    const onOpen = vi.fn();
    const client = {
      service: () => ({
        find: async () => ({ ...status, state: 'critical' }),
        on: vi.fn(),
        off: vi.fn(),
      }),
    } as unknown as AgorClient;
    render(
      <MemoryRouter>
        <MobileHeaderAccessory.Provider
          value={<PowerStatusIndicator client={client} user={user} onOpen={onOpen} />}
        >
          <MobileHeader
            title="A deliberately long fictional Session title for mobile monitoring"
            user={user}
          />
        </MobileHeaderAccessory.Provider>
      </MemoryRouter>
    );
    const indicator = await screen.findByRole('button', { name: 'UPS CRITICAL · Observe' });
    expect(indicator.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
    fireEvent.click(indicator);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('shows real controls without horizontal overflow in dark theme and respects priority authority', async () => {
    const client = {
      service: (path: string) => ({
        find: async () =>
          path === 'power-management'
            ? status
            : path === 'sessions'
              ? { data: [session], total: 1 }
              : {
                  session_id: session.session_id,
                  requested: 'essential',
                  effective: true,
                  can_manage: false,
                  max_essential_sessions: 1,
                },
        on: vi.fn(),
        off: vi.fn(),
      }),
    } as unknown as AgorClient;
    render(
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
        <PowerManagementTab client={client} currentUser={user} />
      </ConfigProvider>
    );
    expect(await screen.findByText('UPS power management')).toBeInTheDocument();
    expect(await screen.findByText('72%')).toBeInTheDocument();
    expect(
      screen.getByText('Observe only — power policy does not gate dispatch')
    ).toBeInTheDocument();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Session to manage' }));
    fireEvent.click(await screen.findByText(/Demo outage checklist · .* · Essential/));
    expect(await screen.findByRole('combobox', { name: 'Power priority' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Validate and generate YAML' }));
    expect(await screen.findByText(/Validated draft only/)).toBeInTheDocument();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
  });
});
