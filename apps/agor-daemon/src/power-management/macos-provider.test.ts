import { describe, expect, it, vi } from 'vitest';
import { MacOSPowerSourceProvider, parseMacOSPowerStatus } from './macos-provider.js';

describe('parseMacOSPowerStatus', () => {
  it('parses AC and UPS facts while discarding device identity', () => {
    expect(
      parseMacOSPowerStatus(
        "Now drawing from 'AC Power'\n -Fictional Device (id=7) 95%; charging present: true\n"
      )
    ).toEqual({ condition: 'online', communication: 'ok', chargePercent: 95 });
    expect(
      parseMacOSPowerStatus(
        "Now drawing from 'UPS Power'\n -Fictional Device (id=7) 18%; discharging; 0:04 remaining present: true; low battery\n"
      )
    ).toEqual({
      condition: 'battery',
      communication: 'ok',
      chargePercent: 18,
      runtimeSeconds: 240,
      critical: true,
    });
  });

  it.each([
    ['', 'provider_unavailable'],
    ["Now drawing from 'Solar Power'\n present: true", 'contradictory_observation'],
    [
      "Now drawing from 'AC Power'\nNow drawing from 'UPS Power'\n present: true",
      'contradictory_observation',
    ],
    [`Now drawing from 'AC Power'\n${'x'.repeat(17_000)}`, 'provider_unavailable'],
  ])('rejects malformed or bounded output without retaining raw text', (raw, reason) => {
    const result = parseMacOSPowerStatus(raw);
    expect(result).toMatchObject({ condition: 'unknown', communication: 'ok', reason });
    expect(JSON.stringify(result)).not.toContain('Solar');
    expect(JSON.stringify(result)).not.toContain('x'.repeat(100));
  });

  it('accepts missing optional charge/runtime values', () => {
    expect(parseMacOSPowerStatus("Now drawing from 'UPS Power'\n present: true\n")).toEqual({
      condition: 'battery',
      communication: 'ok',
    });
  });

  it('drops implausible runtime values instead of overflowing bounded telemetry', () => {
    expect(
      parseMacOSPowerStatus(
        `Now drawing from 'UPS Power'\n 90%; 999999999999999999999:00 remaining present: true\n`
      )
    ).toEqual({ condition: 'battery', communication: 'ok', chargePercent: 90 });
  });
});

describe('MacOSPowerSourceProvider', () => {
  it('uses only the fixed read-only command and bounded options', async () => {
    const runner = vi.fn(async () => "Now drawing from 'AC Power'\n present: true\n");
    const provider = new MacOSPowerSourceProvider(1_500, runner, 'darwin');
    await expect(provider.read()).resolves.toMatchObject({ condition: 'online' });
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        file: '/usr/bin/pmset',
        args: ['-g', 'ps'],
        timeoutMs: 1_500,
        maxOutputBytes: 16 * 1024,
      })
    );
  });

  it('uses a live-updated timeout on the next read', async () => {
    const runner = vi.fn(async () => "Now drawing from 'AC Power'\n present: true\n");
    const provider = new MacOSPowerSourceProvider(1_500, runner, 'darwin');
    provider.setTimeoutMs(750);
    await provider.read();
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 750 }));
  });

  it('redacts command errors and rejects unsupported platforms', async () => {
    const provider = new MacOSPowerSourceProvider(
      500,
      async () => {
        throw new Error('fictional-sensitive-command-output');
      },
      'darwin'
    );
    const result = await provider.read();
    expect(result).toEqual({
      condition: 'unknown',
      communication: 'lost',
      reason: 'provider_unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('fictional-sensitive');
    expect(() => new MacOSPowerSourceProvider(500, vi.fn(), 'linux')).toThrow(/requires macOS/);
  });

  it('aborts an active bounded read on close', async () => {
    let observedSignal: AbortSignal | undefined;
    const provider = new MacOSPowerSourceProvider(
      500,
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      'darwin'
    );
    const read = provider.read();
    await provider.close();
    await expect(read).resolves.toMatchObject({ communication: 'lost' });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('returns a redacted communication loss when even an injected runner times out', async () => {
    const provider = new MacOSPowerSourceProvider(10, () => new Promise(() => undefined), 'darwin');
    await expect(provider.read()).resolves.toEqual({
      condition: 'unknown',
      communication: 'lost',
      reason: 'provider_unavailable',
    });
  });
});
