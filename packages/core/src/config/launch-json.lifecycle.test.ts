import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderBranchSnapshot } from '../environment/render-snapshot';
import { assertEnvCommandAllowed } from '../unix/environment-command-deny-list';
import { parseLaunchJsonDocument } from './launch-json';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function eventually(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  assertion();
}

describe.skipIf(process.platform === 'win32')('launch profile lifecycle', () => {
  it('starts in the background, captures logs, and stops only its supervised process', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agor-launch-lifecycle-'));
    temporaryDirectories.push(directory);
    const environment = parseLaunchJsonDocument(
      {
        configurations: [
          {
            name: 'test server',
            request: 'launch',
            runtimeExecutable: process.execPath,
            args: ['-e', 'setInterval(() => console.log("ready"), 20)'],
          },
        ],
      },
      '.agor/launch.json'
    );
    const snapshot = renderBranchSnapshot(
      { slug: 'fixture', environment },
      { branch_unique_id: 42, name: 'fixture', path: directory }
    )!;

    assertEnvCommandAllowed(snapshot.start, 'start');
    assertEnvCommandAllowed(snapshot.stop, 'stop');
    assertEnvCommandAllowed(snapshot.nuke!, 'nuke');
    assertEnvCommandAllowed(snapshot.logs!, 'logs');

    execFileSync('/bin/sh', ['-c', snapshot.start], { cwd: directory });
    const runtimeRoot = path.join(
      process.env.TMPDIR || '/tmp',
      'agor-launch',
      await import('node:crypto').then(({ createHash }) =>
        createHash('sha256').update(fs.realpathSync(directory)).digest('hex')
      ),
      'test-server-42'
    );
    temporaryDirectories.push(runtimeRoot);
    const pidFile = path.join(runtimeRoot, 'pid');
    const logFile = path.join(runtimeRoot, 'output.log');
    await eventually(() => {
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.readFileSync(logFile, 'utf8')).toContain('ready');
    });
    expect(fs.statSync(runtimeRoot).mode & 0o777).toBe(0o700);

    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(() => process.kill(pid, 0)).not.toThrow();
    execFileSync('/bin/sh', ['-c', snapshot.stop], { cwd: directory });
    await eventually(() => expect(() => process.kill(pid, 0)).toThrow());
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(fs.existsSync(path.join(directory, '.agor'))).toBe(false);
    execFileSync('/bin/sh', ['-c', snapshot.nuke!], { cwd: directory });
    expect(fs.existsSync(runtimeRoot)).toBe(false);
  });
});
