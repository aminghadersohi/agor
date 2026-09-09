import type { AgorClient, PowerManagementStatus } from '@agor-live/client';
import {
  powerManagementMutableSettingsFromResolved,
  powerManagementSettingsFromResolved,
  resolvePowerManagementConfig,
} from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PowerConfigurationEditor } from './PowerConfigurationEditor';

const operator = resolvePowerManagementConfig({ mode: 'off' });
const active = resolvePowerManagementConfig({ mode: 'observe' });
const status = (revision = 3): PowerManagementStatus => ({
  mode: 'observe',
  state: 'unknown',
  freshness: 'unavailable',
  reason: 'startup',
  transitioned_at: '2026-01-01T00:00:00.000Z',
  would_hold: true,
  held: false,
  provider_supported: true,
  configuration: powerManagementSettingsFromResolved(active),
  runtime_settings: {
    revision,
    source: 'runtime_override',
    operator_defaults: powerManagementSettingsFromResolved(operator),
    runtime_override: powerManagementMutableSettingsFromResolved(active),
    can_rollback: true,
    rollback_target: 'runtime_override',
  },
});

function fixture() {
  const patch = vi.fn(async () => ({ ...status(9), mode: 'observe' as const }));
  return {
    patch,
    client: { service: vi.fn(() => ({ patch })) } as unknown as AgorClient,
  };
}

async function confirm(buttonName: string, confirmationName: string) {
  fireEvent.click(screen.getByRole('button', { name: buttonName }));
  const confirmations = await screen.findAllByRole('button', { name: confirmationName });
  fireEvent.click(confirmations.at(-1)!);
}

describe('UPS live policy editor', () => {
  it('applies a validated mutable override without provider/config-file mutation', async () => {
    const { client, patch } = fixture();
    render(<PowerConfigurationEditor client={client} status={status()} />);

    await confirm('Apply live', 'Apply live');
    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(patch).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        expected_revision: 3,
        configuration: expect.objectContaining({ mode: 'observe' }),
      })
    );
    const request = patch.mock.calls[0][1] as { configuration: Record<string, unknown> };
    expect(request.configuration).not.toHaveProperty('provider');
    expect(request.configuration).not.toHaveProperty('max_essential_sessions');
    expect(await screen.findByText(/active without a daemon restart/)).toBeInTheDocument();
  });

  it('validates timing before mutation and can discard unsaved edits', async () => {
    const { client, patch } = fixture();
    render(<PowerConfigurationEditor client={client} status={status()} />);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Provider timeout (ms)' }), {
      target: { value: '5000' },
    });
    await confirm('Apply live', 'Apply live');
    expect(await screen.findByText(/must be less than poll_interval_ms/)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved edits' }));
    expect(screen.getByRole('spinbutton', { name: 'Provider timeout (ms)' })).toHaveValue('2000');
  });

  it('uses exact revision CAS for reset and audited rollback', async () => {
    const { client, patch } = fixture();
    render(<PowerConfigurationEditor client={client} status={status(8)} />);
    await confirm('Reset to operator defaults', 'Reset and apply');
    expect(patch).toHaveBeenLastCalledWith(null, {
      expected_revision: 8,
      reset_to_operator_defaults: true,
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Roll back last change' })).toBeEnabled()
    );
    await confirm('Roll back last change', 'Roll back live');
    expect(patch).toHaveBeenLastCalledWith(null, {
      expected_revision: 9,
      rollback_last_change: true,
    });
  });

  it('converges a stale tab to the realtime revision and reports CAS conflicts', async () => {
    const conflict = Object.assign(new Error('conflict'), { code: 409 });
    const patch = vi.fn(async () => {
      throw conflict;
    });
    const client = { service: vi.fn(() => ({ patch })) } as unknown as AgorClient;
    const rendered = render(<PowerConfigurationEditor client={client} status={status(3)} />);
    await confirm('Apply live', 'Apply live');
    expect(await screen.findByText(/newer revision/)).toBeInTheDocument();

    const converged = status(4);
    converged.configuration = powerManagementSettingsFromResolved(
      resolvePowerManagementConfig({ mode: 'off' })
    );
    rendered.rerender(<PowerConfigurationEditor client={client} status={converged} />);
    expect(await screen.findByText(/converged runtime revision/)).toBeInTheDocument();
    expect(screen.getByText('Active mode: off.', { exact: false })).toBeInTheDocument();
  });
});
