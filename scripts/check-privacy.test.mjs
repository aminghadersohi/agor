import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { addedLines, parsePolicy, scanText } from './check-privacy.mjs';

const SCRIPT = fileURLToPath(new URL('./check-privacy.mjs', import.meta.url));
const where = { path: 'f', line: 1 };

// Fixtures are assembled at runtime so this file never contains a literal the
// guard would flag when it scans its own commit.
const randomish = (n) => {
  const alphabet = 'AbCdEfGhJkLmNpQrStUvWxYz23456789QwZpLmKvRt';
  let out = '';
  for (let i = 0; i < n; i += 1) out += alphabet[(i * 7 + (i % 5) * 3) % alphabet.length];
  return out;
};
const ghToken = ['ghp', randomish(36)].join('_');
const homePath = ['', 'Users', 'jdoe', 'code', 'app'].join('/');
const machineEmail = ['dev', ['Someones', 'MacBook', 'Pro.local'].join('-')].join('@');
const kbLink = ['agor:', '', 'kb', `teammate-${'0a1b2c3d4e5f6a7b8c9d'}`, 'notes.md'].join('/');
const slackLike = ['D0', 'QZ7PXK3MW'].join('');
const plainEmail = ['someone', 'company.io'].join('@');

const rules = (text, opts = {}) =>
  scanText(text, { where, ...opts }).map((f) => `${f.rule}:${f.severity}`);

describe('generic detectors', () => {
  it('blocks a real-looking credential but not a fixture placeholder', () => {
    assert.deepEqual(rules(`token = "${ghToken}"`), ['credential-token:block']);
    assert.deepEqual(rules(`token = "${['xoxb', 'test', 'token'].join('-')}"`), []);
  });

  it('blocks a private key body but not a placeholder header', () => {
    const header = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
    assert.deepEqual(rules(`${header}\\n${randomish(64)}`), ['private-key:block']);
    assert.deepEqual(rules(`${header}\\n...`), []);
  });

  it('blocks personal home directories and allows generic ones', () => {
    assert.deepEqual(rules(`cd ${homePath}`), ['home-directory:block']);
    assert.deepEqual(rules(['', 'home', 'user', 'x'].join('/')), []);
    assert.deepEqual(rules(['', 'Users', '<you>', 'x'].join('/')), []);
  });

  it('blocks machine-local identities and instance knowledge links', () => {
    assert.ok(rules(`author ${machineEmail}`).includes('machine-hostname:block'));
    assert.deepEqual(rules(`see ${kbLink}`), ['instance-knowledge-link:block']);
    assert.deepEqual(rules('see agor://kb/team-skills/skills/x.md'), []);
  });

  it('warns on random-looking Slack IDs and unknown emails only', () => {
    assert.deepEqual(rules(`channel ${slackLike}`), ['slack-id:warn']);
    assert.deepEqual(rules('channel C0123ABC456'), []);
    assert.deepEqual(rules(`mail ${plainEmail}`), ['email-address:warn']);
    assert.deepEqual(rules('mail alice@example.com'), []);
  });
});

describe('private policy', () => {
  it('reports the rule number, never the matched text', () => {
    const policy = parsePolicy('# comment\n\nacme\\s*widgets\n');
    const findings = scanText('Launching ACME Widgets today', { where, policy });
    assert.deepEqual(findings, [
      { path: 'f', line: 1, rule: 'private-policy #1', severity: 'block' },
    ]);
    assert.ok(!JSON.stringify(findings).toLowerCase().includes('widgets'));
  });

  it('supports case-sensitive rules', () => {
    const policy = parsePolicy('case:\\bRiver\\b');
    assert.equal(scanText('River joined', { where, policy }).length, 1);
    assert.equal(scanText('the river joined', { where, policy }).length, 0);
  });

  it('rejects an invalid rule without echoing it', () => {
    assert.throws(() => parsePolicy('ok\n(unclosed'), /rule #2 is not a valid/);
  });
});

describe('addedLines', () => {
  it('maps added lines to new-file line numbers', () => {
    const diff = ['+++ b/a.txt', '@@ -1,0 +3,2 @@', '+one', '+two', '+++ /dev/null', '+gone'].join(
      '\n'
    );
    assert.deepEqual(addedLines(diff), [
      { path: 'a.txt', line: 3, text: 'one' },
      { path: 'a.txt', line: 4, text: 'two' },
    ]);
  });
});

describe('CLI against a scratch repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-guard-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const env = {
    ...process.env,
    AGOR_PRIVACY_POLICY: 'acme\\s*widgets',
    AGOR_PRIVACY_POLICY_FILE: '',
    HOME: dir,
  };
  const cli = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, env, encoding: 'utf8' });

  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'shared.txt'), 'inherited acme widgets line\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('branch', 'baseline');

  it('fails staged changes without printing matched text', () => {
    writeFileSync(join(dir, 'new.txt'), `ACME Widgets plan\nkey ${ghToken}\n`);
    git('add', 'new.txt');
    const res = cli('--staged');
    assert.equal(res.status, 1);
    assert.match(res.stdout, /new\.txt:1 private-policy #1/);
    assert.match(res.stdout, /new\.txt:2 credential-token/);
    assert.ok(!/widgets/i.test(res.stdout + res.stderr));
    assert.ok(!res.stdout.includes(ghToken));
    git('reset', '-q');
    rmSync(join(dir, 'new.txt'));
  });

  it('skips lines that already exist in the excluded baseline ref', () => {
    git('checkout', '-q', '-b', 'topic');
    writeFileSync(join(dir, 'shared.txt'), 'inherited acme widgets line\nclean addition\n');
    git('commit', '-q', '-am', 'clean change');
    assert.equal(cli('--range', 'main..topic', '--exclude-ref', 'baseline').status, 0);
  });

  it('flags commit metadata from a machine-local identity', () => {
    writeFileSync(join(dir, 'other.txt'), 'fine\n');
    git('add', 'other.txt');
    execFileSync('git', ['commit', '-q', '-m', 'local identity'], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_COMMITTER_EMAIL: machineEmail,
        GIT_AUTHOR_EMAIL: 'test@example.com',
      },
    });
    const res = cli('--range', 'main..topic', '--exclude-ref', 'baseline');
    assert.equal(res.status, 1);
    assert.match(res.stdout, /commit [0-9a-f]{10}:identity machine-identity/);
  });
});
