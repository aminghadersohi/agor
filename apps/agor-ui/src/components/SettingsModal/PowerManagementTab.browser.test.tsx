import type { AgorClient, PowerManagementStatus, Session, User } from '@agor-live/client';
import {
  powerManagementMutableSettingsFromResolved,
  powerManagementSettingsFromResolved,
  resolvePowerManagementConfig,
} from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
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
  provider_supported: true,
  configuration: powerManagementSettingsFromResolved(
    resolvePowerManagementConfig({ mode: 'observe' })
  ),
  runtime_settings: {
    revision: 4,
    source: 'runtime_override',
    operator_defaults: powerManagementSettingsFromResolved(
      resolvePowerManagementConfig({ mode: 'off' })
    ),
    runtime_override: powerManagementMutableSettingsFromResolved(
      resolvePowerManagementConfig({ mode: 'observe' })
    ),
    can_rollback: true,
    rollback_target: 'runtime_override',
  },
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
    const indicator = await screen.findByRole('button', {
      name: 'Power source: Battery power (critical). Power conservation: Observe.',
    });
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
            : path === 'power-management/essential-sessions'
              ? { data: [session], selected: session, slot_occupied: true, limit: 30 }
              : path === 'sessions'
                ? { data: [], total: 0 }
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
    expect(screen.getByText('Power source monitoring')).toBeInTheDocument();
    expect(screen.getAllByText('Battery power')).not.toHaveLength(0);
    expect(screen.getByText('Detected')).toBeInTheDocument();
    expect(screen.getByText('Power conservation policy')).toBeInTheDocument();
    expect(await screen.findByText('72%')).toBeInTheDocument();
    expect(
      screen.getByText('Power conservation is Observe — Sessions are not gated')
    ).toBeInTheDocument();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
    fireEvent.click(screen.getByRole('button', { name: 'Manage current Session' }));
    expect(await screen.findByRole('combobox', { name: 'Power priority' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply live' }));
    expect(await screen.findByText(/Apply observe live/i)).toBeInTheDocument();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
  });

  it('shows detected utility power separately from an Off conservation policy', async () => {
    const offStatus: PowerManagementStatus = {
      ...status,
      mode: 'off',
      state: 'disabled',
      reason: 'disabled',
      would_hold: false,
      observation: { ...status.observation!, condition: 'online' },
    };
    const client = {
      service: (path: string) => ({
        find: async () => (path === 'power-management' ? offStatus : { data: [], total: 0 }),
        on: vi.fn(),
        off: vi.fn(),
      }),
    } as unknown as AgorClient;

    render(<PowerManagementTab client={client} currentUser={user} />);

    expect(await screen.findByText('Power source monitoring')).toBeInTheDocument();
    expect(screen.getAllByText('Utility power')).not.toHaveLength(0);
    expect(screen.getByText('Detected')).toBeInTheDocument();
    expect(screen.getAllByText('Off')).not.toHaveLength(0);
    expect(
      screen.getByText(
        'Power conservation is Off — Sessions and schedules are unaffected by UPS conditions'
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/without restarting the daemon/)).toBeInTheDocument();
    expect(screen.queryByText(/^UPS OFF$/i)).not.toBeInTheDocument();
  });

  it('converges another admin tab directly from the complete realtime policy event', async () => {
    let onPatched: ((next: PowerManagementStatus) => void) | undefined;
    const powerService = {
      find: async () => status,
      on: (event: string, handler: (next: PowerManagementStatus) => void) => {
        if (event === 'patched') onPatched = handler;
      },
      off: vi.fn(),
    };
    const client = {
      service: (path: string) =>
        path === 'power-management'
          ? powerService
          : {
              find: async () => ({ data: [], slot_occupied: false, limit: 30 }),
              on: vi.fn(),
              off: vi.fn(),
            },
    } as unknown as AgorClient;
    render(<PowerManagementTab client={client} currentUser={user} />);
    expect(await screen.findByText('Live mutable policy · revision 4')).toBeInTheDocument();

    const next: PowerManagementStatus = {
      ...status,
      mode: 'off',
      state: 'disabled',
      reason: 'disabled',
      held: false,
      would_hold: false,
      configuration: powerManagementSettingsFromResolved(
        resolvePowerManagementConfig({ mode: 'off' })
      ),
      runtime_settings: { ...status.runtime_settings!, revision: 5 },
    };
    await act(async () => onPatched?.(next));
    expect(await screen.findByText('Live mutable policy · revision 5')).toBeInTheDocument();
    expect(screen.getByText('Active mode: off.', { exact: false })).toBeInTheDocument();
  });

  it.each([
    [
      'unavailable',
      { ...status, freshness: 'unavailable', observation: undefined },
      'Provider unavailable',
    ],
    ['stale', { ...status, freshness: 'stale' }, 'Provider stale'],
    [
      'unsupported topology',
      { ...status, provider_supported: false, observation: undefined },
      'Unsupported topology',
    ],
  ] as Array<[string, PowerManagementStatus, string]>)(
    'does not claim UPS detection when the provider is %s',
    async (_case, providerStatus, expected) => {
      const client = {
        service: (path: string) => ({
          find: async () => (path === 'power-management' ? providerStatus : { data: [], total: 0 }),
          on: vi.fn(),
          off: vi.fn(),
        }),
      } as unknown as AgorClient;

      render(<PowerManagementTab client={client} currentUser={user} />);

      expect((await screen.findAllByText(expected)).length).toBeGreaterThan(0);
      expect(screen.getByText('Detection unavailable')).toBeInTheDocument();
      expect(screen.queryByText('Detected')).not.toBeInTheDocument();
    }
  );

  it('shows battery Enforce as a separate policy mode and admission decision', async () => {
    const enforceStatus: PowerManagementStatus = {
      ...status,
      mode: 'enforce',
      state: 'conserve',
      held: true,
      would_hold: true,
    };
    const client = {
      service: (path: string) => ({
        find: async () => (path === 'power-management' ? enforceStatus : { data: [], total: 0 }),
        on: vi.fn(),
        off: vi.fn(),
      }),
    } as unknown as AgorClient;

    render(<PowerManagementTab client={client} currentUser={user} />);

    expect((await screen.findAllByText('Battery power')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Enforce')).not.toHaveLength(0);
    expect(screen.getByText('Held by power policy')).toBeInTheDocument();
    expect(
      screen.queryByText('Power conservation is Observe — Sessions are not gated')
    ).not.toBeInTheDocument();
  });

  it('keeps 850-Session selection bounded, searchable, keyboard operable, and pager-free', async () => {
    const authorizedSessions = Array.from({ length: 850 }, (_, index) => ({
      session_id: `018f0000-0000-7000-8000-${String(index).padStart(12, '0')}`,
      title: `Fictional Session ${index + 1}`,
      power_priority: 'normal',
    })) as Session[];
    const sessionFind = vi.fn(async (params?: { query?: Record<string, unknown> }) => {
      const search = String(params?.query?.search ?? '').toLowerCase();
      const matches = search
        ? authorizedSessions.filter((candidate) => candidate.title.toLowerCase().includes(search))
        : authorizedSessions;
      return { data: matches.slice(0, 30), slot_occupied: false, limit: 30 };
    });
    const client = {
      service: (path: string) => ({
        find:
          path === 'power-management'
            ? async () => status
            : path === 'power-management/essential-sessions'
              ? sessionFind
              : async () => ({ data: [], total: 0 }),
        on: vi.fn(),
        off: vi.fn(),
      }),
    } as unknown as AgorClient;

    render(<PowerManagementTab client={client} currentUser={user} />);

    const picker = await screen.findByRole('combobox', { name: 'Session to manage' });
    picker.focus();
    expect(picker).toHaveFocus();
    await act(async () => userEvent.keyboard('Session 850'));
    await waitFor(() =>
      expect(sessionFind).toHaveBeenLastCalledWith({ query: { search: 'Session 850' } })
    );
    expect(document.querySelector('.ant-pagination')).not.toBeInTheDocument();
    expect(JSON.stringify(sessionFind.mock.calls)).not.toContain('$skip');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
  });
});
