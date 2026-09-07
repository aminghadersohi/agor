import {
  powerManagementSettingsFromResolved,
  resolvePowerManagementConfig,
} from '@agor-live/client';
import { load } from '@agor-live/client/yaml';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PowerConfigurationEditor } from './PowerConfigurationEditor';

const configuration = powerManagementSettingsFromResolved(resolvePowerManagementConfig(undefined));
describe('UPS configuration draft', () => {
  it('generates supported YAML without claiming to apply it, then invalidates the result on edits', async () => {
    render(<PowerConfigurationEditor configuration={configuration} />);
    fireEvent.click(screen.getByRole('button', { name: 'Validate and generate YAML' }));
    expect(await screen.findByText(/Validated draft only/)).toBeInTheDocument();
    const yaml = document.querySelector('pre')?.textContent;
    expect(load(yaml ?? '')).toMatchObject({ execution: { power_management: configuration } });
    expect(yaml).toContain('last_on_battery_critical_after_ms: 30000');
    expect(yaml).toContain('max_essential_sessions: 1');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Provider timeout (ms)' }), {
      target: { value: '5000' },
    });
    expect(document.querySelector('pre')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Validate and generate YAML' }));
    expect(await screen.findByText(/must be less than poll_interval_ms/)).toBeInTheDocument();
    expect(document.querySelector('pre')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset draft to active configuration' }));
    expect(screen.getByRole('spinbutton', { name: 'Provider timeout (ms)' })).toHaveValue('2000');
  }, 30_000);
});
