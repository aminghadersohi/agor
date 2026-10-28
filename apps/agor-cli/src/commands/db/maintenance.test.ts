import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const cliRoot = resolve(import.meta.dirname, '../../..');

describe('maintenance operator CLI refusals', () => {
  for (const args of [
    ['--action', 'acquire', '--install'],
    ['--action', 'release'],
    ['--action', 'inspect', '--install'],
  ]) {
    it(`refuses ${args.join(' ')} without a real PostgreSQL operator fence`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'agor-maintenance-cli-'));
      try {
        const result = await execute(
          process.execPath,
          ['--import', 'tsx', 'bin/dev.ts', 'db', 'maintenance', ...args],
          {
            cwd: cliRoot,
            timeout: 15000,
            env: {
              ...process.env,
              HOME: home,
              USERPROFILE: home,
              AGOR_HOME: home,
              AGOR_DB_DIALECT: 'sqlite',
              AGOR_DB_PATH: join(home, 'fixture.db'),
              DATABASE_URL: '',
              NODE_OPTIONS: '--conditions=source',
            },
          }
        ).then(
          (r) => ({ code: 0, ...r }),
          (e) => ({ code: e.code, stdout: e.stdout as string, stderr: e.stderr as string })
        );
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('Maintenance operation refused or failed');
        expect(result.stderr).not.toMatch(/\bSELECT\b|\bUPDATE\b|postgresql:\/\//);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }, 20000);
  }
});
