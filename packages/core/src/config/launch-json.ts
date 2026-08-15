import type { RepoEnvironment, RepoEnvironmentVariant } from '../types/branch';

export const LAUNCH_JSON_PATHS = ['.agor/launch.json', '.vscode/launch.json'] as const;
export type LaunchJsonPath = (typeof LAUNCH_JSON_PATHS)[number];
const WORKSPACE_FOLDER_VARIABLE = `$${'{workspaceFolder}'}`;
const WORKSPACE_ROOT_VARIABLE = `$${'{workspaceRoot}'}`;

interface LaunchConfiguration {
  name?: unknown;
  request?: unknown;
  type?: unknown;
  runtimeExecutable?: unknown;
  runtimeArgs?: unknown;
  program?: unknown;
  args?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  agor?: unknown;
  preLaunchTask?: unknown;
  postDebugTask?: unknown;
  envFile?: unknown;
}

interface AgorLaunchExtension {
  description?: unknown;
  default?: unknown;
  background?: unknown;
  stop?: unknown;
  nuke?: unknown;
  logs?: unknown;
  health?: unknown;
  app?: unknown;
}

export interface LaunchJsonDocument {
  version?: unknown;
  configurations?: unknown;
  compounds?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function expectStringArray(value: unknown, field: string, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Launch configuration "${name}" field "${field}" must be an array of strings`);
  }
  return value;
}

function translateVariable(value: string): string {
  const translated = value
    .replaceAll(WORKSPACE_FOLDER_VARIABLE, '.')
    .replaceAll(WORKSPACE_ROOT_VARIABLE, '.');
  const unsupported = translated.match(/\$\{(?:env|config|command|input):[^}]+\}/)?.[0];
  if (unsupported) {
    throw new Error(
      `Unsupported launch variable "${unsupported}"; use an Agor template or profile env value`
    );
  }
  return translated;
}

function safeProfileSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'launch';
}

function compileCommand(config: LaunchConfiguration, name: string): string {
  if (typeof config.command === 'string' && config.command.trim()) {
    return translateVariable(config.command.trim());
  }

  const executable =
    typeof config.runtimeExecutable === 'string'
      ? config.runtimeExecutable
      : typeof config.program === 'string' && ['node', 'pwa-node'].includes(String(config.type))
        ? 'node'
        : undefined;
  if (!executable) {
    throw new Error(
      `Launch configuration "${name}" needs "command" or "runtimeExecutable" (Node profiles may use "program")`
    );
  }

  const values = [
    translateVariable(executable),
    ...expectStringArray(config.runtimeArgs, 'runtimeArgs', name).map(translateVariable),
    ...(typeof config.program === 'string' ? [translateVariable(config.program)] : []),
    ...expectStringArray(config.args, 'args', name).map(translateVariable),
  ];
  return values.map(shellQuote).join(' ');
}

function compileEnvironment(value: unknown, name: string): string {
  if (value === undefined) return '';
  if (!isRecord(value)) {
    throw new Error(`Launch configuration "${name}" field "env" must be an object`);
  }
  return Object.entries(value)
    .map(([key, raw]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Launch configuration "${name}" has invalid environment key "${key}"`);
      }
      if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
        throw new Error(`Launch configuration "${name}" environment value "${key}" must be scalar`);
      }
      return `${key}=${shellQuote(translateVariable(String(raw)))}`;
    })
    .join(' ');
}

function optionalString(
  extension: AgorLaunchExtension,
  key: keyof AgorLaunchExtension
): string | undefined {
  const value = extension[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Launch field "agor.${key}" must be a string`);
  return translateVariable(value);
}

function compileConfiguration(
  config: LaunchConfiguration,
  sourcePath: LaunchJsonPath
): { name: string; variant: RepoEnvironmentVariant; isDefault: boolean } {
  if (typeof config.name !== 'string' || !config.name.trim()) {
    throw new Error('Every launch configuration must have a non-empty string "name"');
  }
  const name = config.name.trim();
  if (config.request !== undefined && config.request !== 'launch') {
    throw new Error(
      `Launch configuration "${name}" uses request "${String(config.request)}"; only "launch" is supported`
    );
  }
  for (const unsupportedField of ['preLaunchTask', 'postDebugTask', 'envFile']) {
    if (unsupportedField in config) {
      throw new Error(
        `Launch configuration "${name}" uses unsupported field "${unsupportedField}"`
      );
    }
  }
  const extension: AgorLaunchExtension = isRecord(config.agor) ? config.agor : {};
  const command = compileCommand(config, name);
  const env = compileEnvironment(config.env, name);
  const cwd = typeof config.cwd === 'string' ? translateVariable(config.cwd) : '.';
  const foreground = [env, command].filter(Boolean).join(' ');
  const slug = safeProfileSlug(name);
  const marker = `agor-launch-${slug}-{{branch.unique_id}}`;
  const runtimeSetup = [
    `agor_runtime_root="$${'{TMPDIR:-/tmp}'}/agor-launch"`,
    `agor_runtime_key="$(node -e ${shellQuote("process.stdout.write(require('node:crypto').createHash('sha256').update(process.cwd()).digest('hex'))")})"`,
    `run_dir="$agor_runtime_root/$agor_runtime_key/${slug}-{{branch.unique_id}}"`,
  ].join('; ');
  const background = extension.background !== false;
  const stopOverride = optionalString(extension, 'stop');
  if (!background && !stopOverride) {
    throw new Error(
      `Launch configuration "${name}" sets "agor.background" to false and must provide "agor.stop"`
    );
  }

  const supervisor = [
    'run_dir=$1',
    'child=',
    'cleanup() { test -z "$child" || kill "$child" 2>/dev/null || true; rm -f "$run_dir/pid"; }',
    'trap cleanup TERM INT',
    `cd ${shellQuote(cwd)} || exit 1`,
    `${foreground} & child=$!`,
    'wait "$child"',
    'status=$?',
    'rm -f "$run_dir/pid"',
    'exit "$status"',
  ].join('; ');
  const generatedStart = background
    ? `${runtimeSetup}; mkdir -p "$run_dir"; chmod 700 "$run_dir"; nohup sh -c ${shellQuote(supervisor)} ${shellQuote(marker)} "$run_dir" > "$run_dir/output.log" 2>&1 < /dev/null & echo $! > "$run_dir/pid"`
    : `cd ${shellQuote(cwd)} && ${foreground}`;
  const stopTree = `stop_tree() { if command -v pgrep >/dev/null 2>&1; then for child_pid in $(pgrep -P "$1" 2>/dev/null); do stop_tree "$child_pid"; done; fi; kill "$1" 2>/dev/null || true; }`;
  const generatedStop = `${runtimeSetup}; ${stopTree}; if test -f "$run_dir/pid"; then pid="$(cat "$run_dir/pid")"; if ps -p "$pid" -o command= 2>/dev/null | grep -F -- ${shellQuote(marker)} >/dev/null; then stop_tree "$pid"; else echo "Refusing to stop stale launch PID $pid" >&2; fi; rm -f "$run_dir/pid"; fi`;
  const stop = stopOverride ?? generatedStop;

  return {
    name,
    isDefault: extension.default === true,
    variant: {
      description:
        typeof extension.description === 'string'
          ? extension.description
          : `Launch profile imported from ${sourcePath}`,
      start: generatedStart,
      stop,
      nuke: optionalString(extension, 'nuke') ?? `${stop}; ${runtimeSetup}; rm -rf "$run_dir"`,
      logs:
        optionalString(extension, 'logs') ??
        (background ? `${runtimeSetup}; tail -n 100 "$run_dir/output.log"` : undefined),
      health: optionalString(extension, 'health'),
      app: optionalString(extension, 'app'),
    },
  };
}

/** Compile VS Code-shaped launch configurations into Agor environment variants. */
export function parseLaunchJsonDocument(
  document: LaunchJsonDocument,
  sourcePath: LaunchJsonPath
): RepoEnvironment {
  if (!isRecord(document) || !Array.isArray(document.configurations)) {
    throw new Error(`${sourcePath} must contain a "configurations" array`);
  }
  if (document.configurations.length === 0) {
    throw new Error(`${sourcePath} has no launch configurations`);
  }
  const compiled = document.configurations.map((item) => {
    if (!isRecord(item)) throw new Error('Every launch configuration must be an object');
    return compileConfiguration(item, sourcePath);
  });
  const defaults = compiled.filter((item) => item.isDefault);
  if (defaults.length > 1)
    throw new Error('Only one launch configuration may set "agor.default": true');
  const variants: Record<string, RepoEnvironmentVariant> = {};
  for (const item of compiled) {
    if (variants[item.name]) throw new Error(`Duplicate launch configuration name "${item.name}"`);
    variants[item.name] = item.variant;
  }
  return { version: 2, default: defaults[0]?.name ?? compiled[0]!.name, variants };
}
