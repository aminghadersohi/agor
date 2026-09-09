import { execFile } from 'node:child_process';
import type { PowerObservation, PowerSourceProvider } from './types.js';

const PMSET_PATH = '/usr/bin/pmset';
const PMSET_ARGS = ['-g', 'ps'] as const;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_LINES = 32;
const MAX_LINE_BYTES = 1_024;

export type MacOSPowerCommandRunner = (input: {
  file: typeof PMSET_PATH;
  args: readonly ['-g', 'ps'];
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}) => Promise<string>;

function defaultRunner(input: Parameters<MacOSPowerCommandRunner>[0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      input.file,
      [...input.args],
      {
        encoding: 'utf8',
        timeout: input.timeoutMs,
        maxBuffer: input.maxOutputBytes,
        windowsHide: true,
        signal: input.signal,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}

function boundedLines(output: string): string[] | null {
  if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) return null;
  const lines = output.split(/\r?\n/);
  if (lines.length > MAX_LINES) return null;
  if (lines.some((line) => Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES)) return null;
  return lines;
}

/** Parse only bounded state facts. No device label or raw line survives this boundary. */
export function parseMacOSPowerStatus(output: string): PowerObservation {
  const lines = boundedLines(output);
  if (!lines) {
    return { condition: 'unknown', communication: 'ok', reason: 'provider_unavailable' };
  }
  const sourceLines = lines.filter((line) =>
    /^Now drawing from\s+['"][^'"]+['"]\s*$/i.test(line.trim())
  );
  if (sourceLines.length !== 1) {
    return {
      condition: 'unknown',
      communication: 'ok',
      reason: sourceLines.length > 1 ? 'contradictory_observation' : 'provider_unavailable',
    };
  }
  const sourceMatch = sourceLines[0]!.trim().match(/^Now drawing from\s+['"]([^'"]+)['"]\s*$/i);
  const source = sourceMatch?.[1]?.trim().toLowerCase();
  const hasPresentPowerSource = lines.some((line) => /\bpresent:\s*true\b/i.test(line));
  if (!source || !hasPresentPowerSource) {
    return { condition: 'unknown', communication: 'ok', reason: 'provider_unavailable' };
  }

  const condition =
    source === 'ac power' ? 'online' : /^(ups|battery) power$/.test(source) ? 'battery' : 'unknown';
  if (condition === 'unknown') {
    return { condition, communication: 'ok', reason: 'contradictory_observation' };
  }

  let chargePercent: number | undefined;
  let runtimeSeconds: number | undefined;
  let critical = false;
  for (const line of lines) {
    const charge = line.match(/(?:^|\s)(\d{1,3})%;/);
    if (charge) {
      const value = Number.parseInt(charge[1]!, 10);
      if (value >= 0 && value <= 100) chargePercent = value;
    }
    const runtime = line.match(/(?:^|\s)(\d+):(\d{2})\s+remaining\b/i);
    if (runtime) {
      const hours = Number.parseInt(runtime[1]!, 10);
      const minutes = Number.parseInt(runtime[2]!, 10);
      // A UPS runtime larger than one year is not credible telemetry. The
      // bound also prevents integer overflow from adversarial command output.
      if (Number.isSafeInteger(hours) && hours <= 24 * 365 && minutes >= 0 && minutes < 60) {
        runtimeSeconds = hours * 3_600 + minutes * 60;
      }
    }
    if (/\b(?:low battery|critical)\b/i.test(line)) critical = true;
  }

  return {
    condition,
    communication: 'ok',
    ...(chargePercent !== undefined ? { chargePercent } : {}),
    ...(runtimeSeconds !== undefined ? { runtimeSeconds } : {}),
    ...(critical ? { critical: true } : {}),
  };
}

export class MacOSPowerSourceProvider implements PowerSourceProvider {
  private activeAbort?: AbortController;
  private closed = false;

  constructor(
    private timeoutMs: number,
    private readonly runner: MacOSPowerCommandRunner = defaultRunner,
    platform: NodeJS.Platform = process.platform
  ) {
    if (platform !== 'darwin') {
      throw new Error('The macos power provider requires macOS');
    }
  }

  setTimeoutMs(timeoutMs: number): void {
    this.timeoutMs = timeoutMs;
  }

  async read(): Promise<PowerObservation> {
    if (this.closed) {
      return { condition: 'unknown', communication: 'lost', reason: 'provider_unavailable' };
    }
    const abort = new AbortController();
    this.activeAbort = abort;
    const timeout = setTimeout(() => abort.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const output = await Promise.race([
        this.runner({
          file: PMSET_PATH,
          args: PMSET_ARGS,
          timeoutMs: this.timeoutMs,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          signal: abort.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          abort.signal.addEventListener('abort', () => reject(new Error('power read aborted')), {
            once: true,
          });
        }),
      ]);
      return parseMacOSPowerStatus(output);
    } catch {
      return { condition: 'unknown', communication: 'lost', reason: 'provider_unavailable' };
    } finally {
      clearTimeout(timeout);
      if (this.activeAbort === abort) this.activeAbort = undefined;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.activeAbort?.abort();
  }
}
