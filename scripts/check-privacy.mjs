#!/usr/bin/env node
// Privacy guard: blocks credentials, machine-local identity and instance-specific
// links before they reach a public branch.
//
// The detectors in this file are generic on purpose. Terms that are private to
// one deployment (people, projects, hosts) belong in a policy file that is never
// committed: pass it with --policy, AGOR_PRIVACY_POLICY_FILE, or the
// AGOR_PRIVACY_POLICY environment variable (CI reads it from a repository
// secret), or keep it at ~/.config/agor/privacy-policy. One JavaScript regular
// expression per line, case-insensitive unless prefixed with `case:`; blank
// lines and lines starting with `#` are ignored. Lines of the form
// `retired:<hex prefix>` name commits withdrawn by a history rewrite: if any of
// them is reachable from a scanned head, the check fails, so a stale clone
// cannot quietly push or merge the old history back.
//
// Findings report the location and the rule, never the matched text, so the
// output is safe to print in public CI logs.
//
// Modes:
//   --staged                 added lines of the staged diff (pre-commit)
//   --range <base>..<head>   added lines of the range and of every commit in it,
//                            commit messages and author/committer identities
//   --new <rev>              like --range for every commit reachable from <rev>
//                            that no remote-tracking ref has yet (pre-push,
//                            pre-merge-commit)
//   --files <path>...        whole files
// Options:
//   --exclude-ref <ref>      skip commits reachable from <ref> and lines that
//                            appear verbatim in <ref>'s copy of the same file
//                            (used to ignore content merged from upstream)
//   --policy <file>          private policy file
//   --strict                 treat warnings as failures

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

const PLACEHOLDER =
  /(example|sample|dummy|fake|test|mock|fixture|placeholder|redacted|secret|token|sentinel|xxxx|abcd|0123|1234|changeme|your[-_]|\$\{|<[^>]*>)/i;

function shannon(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A token-shaped value that is long, random-looking and not an obvious fixture. */
function looksReal(value, minLength = 20) {
  return value.length >= minLength && shannon(value) >= 3.5 && !PLACEHOLDER.test(value);
}

const ALLOWED_HOME_NAMES = new Set([
  'user',
  'username',
  'me',
  'you',
  'runner',
  'agor',
  'node',
  'root',
  'admin',
  'dev',
  'owner',
  'operator',
  'daemon',
  'service',
  'ubuntu',
  'ec2-user',
  'vscode',
  'codespace',
  'docker',
  'app',
  'ci',
  'builder',
  'sandbox',
  'nobody',
  'testuser',
  'test-user',
  'tester',
  'test',
  'example',
  'alice',
  'bob',
  'carol',
  'jane',
  'john',
  'someone',
  'max',
]);

const ALLOWED_EMAIL =
  /(@|\.)(example\.(com|org|net)|test|invalid|localhost|example)$|@users\.noreply\.github\.com$|^noreply@|^no-reply@/i;

/**
 * Generic detectors. `severity: 'block'` fails the check; `'warn'` is reported
 * and fails only with --strict.
 */
export const DETECTORS = [
  {
    id: 'credential-token',
    severity: 'block',
    pattern:
      /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}|xox[abposr]-[A-Za-z0-9-]{20,}|xapp-\d-[A-Za-z0-9-]{20,}|sk-ant-[A-Za-z0-9_-]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{40,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|[rs]k_live_[A-Za-z0-9]{20,}|GOCSPX-[A-Za-z0-9_-]{20,}|do[pr]_v1_[a-f0-9]{60,}|ya29\.[A-Za-z0-9_-]{30,})/g,
    accept: (m) => looksReal(m),
  },
  {
    id: 'private-key',
    severity: 'block',
    pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----\s*[\\n]*\s*[A-Za-z0-9+/]{40,}/g,
  },
  {
    id: 'webhook-url',
    severity: 'block',
    pattern:
      /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}|https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g,
    accept: (m) => looksReal(m.split('/').pop() ?? '', 16),
  },
  {
    id: 'credential-url',
    severity: 'block',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:([^\s@/'"`]{8,})@[^\s'"`]+/gi,
    accept: (_m, groups) => looksReal(groups[0], 8),
  },
  {
    id: 'home-directory',
    severity: 'block',
    pattern: /(?<![\w./-])(?:\/Users|\/home)\/([A-Za-z][A-Za-z0-9._-]{1,31})\//g,
    accept: (_m, groups) => !ALLOWED_HOME_NAMES.has(groups[0].toLowerCase()),
  },
  {
    id: 'machine-hostname',
    severity: 'block',
    pattern:
      /\b[A-Za-z0-9][A-Za-z0-9-]*-(?:MacBook|Mac-mini|Mac-Studio|iMac|Mac-Pro)(?:-[A-Za-z0-9-]+)?(?:\.local)?\b|\b[a-z0-9-]+\.tail[0-9a-f]+\.ts\.net\b/gi,
  },
  {
    id: 'local-domain-email',
    severity: 'warn',
    pattern: /\b[\w.+-]+@[A-Za-z0-9-]+\.(?:local|lan|home)\b/g,
    accept: (m) => !/@(?:test|example|localhost)\./i.test(m),
  },
  {
    id: 'instance-knowledge-link',
    severity: 'block',
    pattern:
      /agor:\/\/kb\/(?:teammate|assistant|user)-[0-9a-f]{16,}|\/ui\/kb\/(?:teammate|assistant|user)-[0-9a-f]{16,}/g,
  },
  {
    id: 'lan-url',
    severity: 'warn',
    pattern:
      /\bhttps?:\/\/(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?::\d+)?\/(?:ui|kb|b)\//g,
  },
  {
    id: 'slack-id',
    severity: 'warn',
    pattern: /\b[UWCDGTBA]0[A-Z0-9]{8,10}\b/g,
    accept: (m) =>
      /\d.*\d.*\d/.test(m) &&
      /[A-Z].*[A-Z].*[A-Z].*[A-Z]/.test(m.slice(2)) &&
      !PLACEHOLDER.test(m) &&
      shannon(m) >= 3,
  },
  {
    id: 'email-address',
    severity: 'warn',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    accept: (m) => !ALLOWED_EMAIL.test(m),
  },
];

export function parsePolicy(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('retired:')) continue;
    const caseSensitive = line.startsWith('case:');
    try {
      rules.push(new RegExp(caseSensitive ? line.slice(5) : line, caseSensitive ? 'g' : 'gi'));
    } catch {
      throw new Error(`privacy policy rule #${rules.length + 1} is not a valid regular expression`);
    }
  }
  return rules;
}

/** `retired:<hex>` lines: commit SHA prefixes withdrawn by a history rewrite. */
export function parseRetired(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^retired:([0-9a-f]{7,40})$/i.exec(raw.trim());
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

function policyText({ policyFile, env }) {
  if (env.AGOR_PRIVACY_POLICY?.trim()) return env.AGOR_PRIVACY_POLICY;
  const candidates = [
    policyFile,
    env.AGOR_PRIVACY_POLICY_FILE,
    join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'agor', 'privacy-policy'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (existsSync(file)) return readFileSync(file, 'utf8');
  }
  return '';
}

export function loadPolicy({ policyFile, env = process.env } = {}) {
  return parsePolicy(policyText({ policyFile, env }));
}

/** Scan one line of text; returns findings without the matched text. */
export function scanText(text, { policy = [], where }) {
  const findings = [];
  for (const det of DETECTORS) {
    det.pattern.lastIndex = 0;
    for (const m of text.matchAll(det.pattern)) {
      if (det.accept && !det.accept(m[0], m.slice(1))) continue;
      findings.push({ ...where, rule: det.id, severity: det.severity });
    }
  }
  policy.forEach((rx, i) => {
    rx.lastIndex = 0;
    if (rx.test(text))
      findings.push({ ...where, rule: `private-policy #${i + 1}`, severity: 'block' });
  });
  return findings;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts });
}

function tryGit(args) {
  try {
    return git(args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Parse `git diff -U0` output into { path, line, text } for added lines. */
export function addedLines(diff) {
  const out = [];
  let path = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      path = raw === '+++ /dev/null' ? null : raw.slice(4).replace(/^b\//, '');
    } else if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw);
      line = m ? Number(m[1]) : 0;
    } else if (raw.startsWith('+') && path) {
      out.push({ path, line, text: raw.slice(1) });
      line += 1;
    } else if (raw.startsWith('Binary files')) {
      // binary content is not scanned
    }
  }
  return out;
}

function baselineLines(excludeRef, path, cache) {
  if (!excludeRef) return null;
  if (!cache.has(path)) {
    const content = tryGit(['show', `${excludeRef}:${path}`]);
    cache.set(path, content === null ? null : new Set(content.split('\n')));
  }
  return cache.get(path);
}

function scanAdded(lines, { policy, excludeRef }) {
  const cache = new Map();
  const findings = [];
  for (const { path, line, text } of lines) {
    if (text.length > 20000) continue;
    const baseline = baselineLines(excludeRef, path, cache);
    if (baseline?.has(text)) continue;
    findings.push(...scanText(text, { policy, where: { path, line } }));
  }
  return findings;
}

function scanCommits(revs, { policy, excludeRef }) {
  // The baseline exclusion goes first: after `--not` a `^ref` would flip back.
  const revArgs = ['rev-list', '--no-merges', ...(excludeRef ? [`^${excludeRef}`] : []), ...revs];
  const out = tryGit(revArgs);
  if (out === null) throw new Error(`cannot list commits for ${revs.join(' ')}`);
  const findings = [];
  for (const sha of out.split('\n').filter(Boolean)) {
    const short = sha.slice(0, 10);
    // Each commit's own additions, so content that a later commit removed is
    // still caught when old history is pushed again.
    findings.push(
      ...scanAdded(
        addedLines(git(['show', '--format=', '-U0', '--no-color', '--no-ext-diff', sha])),
        { policy, excludeRef }
      )
    );
    const meta = git(['show', '-s', '--format=%an%n%ae%n%cn%n%ce', sha]).split('\n');
    const identity = meta.slice(0, 4).join(' ');
    // Public authorship is expected here; machine-local identities are checked below.
    findings.push(
      ...scanText(identity, {
        policy,
        where: { path: `commit ${short}`, line: 'identity' },
      }).filter((f) => f.rule !== 'email-address')
    );
    for (const email of [meta[1], meta[3]]) {
      if (/\.local$|\.lan$|\.internal$|\.home$/i.test(email ?? '')) {
        findings.push({
          path: `commit ${short}`,
          line: 'identity',
          rule: 'machine-identity',
          severity: 'block',
        });
      }
    }
    const message = git(['show', '-s', '--format=%B', sha]);
    message.split('\n').forEach((text, i) => {
      findings.push(
        ...scanText(text, { policy, where: { path: `commit ${short}`, line: `message:${i + 1}` } })
      );
    });
  }
  return findings;
}

/** Fail when any withdrawn commit is reachable from `head` (outside the baseline). */
function scanRetired(head, retired, { excludeRef }) {
  if (!retired.length) return [];
  const args = ['rev-list', head];
  if (excludeRef) args.push(`^${excludeRef}`);
  const out = tryGit(args);
  if (out === null) throw new Error(`cannot list history of ${head}`);
  const hits = out.split('\n').filter((sha) => sha && retired.some((p) => sha.startsWith(p)));
  // Only the count is printed: the commit IDs themselves point at withdrawn content.
  return hits.length
    ? [{ path: head, line: `${hits.length} commit(s)`, rule: 'retired-history', severity: 'block' }]
    : [];
}

function scanFiles(files, { policy }) {
  const findings = [];
  for (const path of files) {
    let buf;
    try {
      buf = readFileSync(path);
    } catch {
      continue;
    }
    if (buf.length > MAX_FILE_BYTES || buf.subarray(0, 8000).includes(0)) continue;
    buf
      .toString('utf8')
      .split('\n')
      .forEach((text, i) => {
        findings.push(...scanText(text, { policy, where: { path, line: i + 1 } }));
      });
  }
  return findings;
}

function parseArgs(argv) {
  const opts = { mode: null, files: [], strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--staged') opts.mode = 'staged';
    else if (a === '--new') {
      opts.mode = 'new';
      opts.rev = argv[++i];
    } else if (a === '--range') {
      opts.mode = 'range';
      opts.range = argv[++i];
    } else if (a === '--files') {
      opts.mode = 'files';
      opts.files = argv.slice(i + 1);
      break;
    } else if (a === '--exclude-ref') opts.excludeRef = argv[++i];
    else if (a === '--policy') opts.policyFile = argv[++i];
    else if (a === '--strict') opts.strict = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.mode)
    throw new Error('choose --staged, --range <base>..<head>, --new <rev> or --files <path>...');
  if (opts.mode === 'range' && !/\.\./.test(opts.range ?? ''))
    throw new Error('--range needs <base>..<head>');
  if (opts.excludeRef && tryGit(['rev-parse', '--verify', '--quiet', opts.excludeRef]) === null) {
    console.warn(
      `privacy: --exclude-ref ${opts.excludeRef} not found; scanning without a baseline`
    );
    opts.excludeRef = undefined;
  }
  return opts;
}

export function run(argv, env = process.env) {
  const opts = parseArgs(argv);
  const text = policyText({ policyFile: opts.policyFile, env });
  const policy = parsePolicy(text);
  const retired = parseRetired(text);
  let findings = [];
  if (opts.mode === 'staged') {
    findings = scanAdded(
      addedLines(git(['diff', '--cached', '-U0', '--no-color', '--no-ext-diff'])),
      {
        policy,
        excludeRef: opts.excludeRef,
      }
    );
  } else if (opts.mode === 'range') {
    const [base, head] = opts.range.split(/\.\.\.?/);
    findings = [
      ...scanAdded(
        addedLines(git(['diff', '-U0', '--no-color', '--no-ext-diff', `${base}...${head}`])),
        {
          policy,
          excludeRef: opts.excludeRef,
        }
      ),
      ...scanCommits([`${base}..${head}`], { policy, excludeRef: opts.excludeRef }),
      ...scanRetired(head, retired, { excludeRef: opts.excludeRef }),
    ];
  } else if (opts.mode === 'new') {
    findings = [
      ...scanCommits([opts.rev, '--not', '--remotes'], { policy, excludeRef: opts.excludeRef }),
      ...scanRetired(opts.rev, retired, { excludeRef: opts.excludeRef }),
    ];
  } else {
    findings = scanFiles(opts.files, { policy });
  }

  const blocking = findings.filter((f) => f.severity === 'block' || opts.strict);
  for (const f of findings) {
    const tag = f.severity === 'block' || opts.strict ? 'error' : 'warning';
    console.log(`${tag}: ${f.path}:${f.line} ${f.rule}`);
  }
  const policyNote = policy.length
    ? `${policy.length} private policy rule(s), ${retired.length} retired commit(s)`
    : 'no private policy';
  console.log(
    `privacy: ${findings.length} finding(s), ${blocking.length} blocking (${policyNote}). Matched text is never printed.`
  );
  return blocking.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`privacy: ${err.message}`);
    process.exitCode = 2;
  }
}
