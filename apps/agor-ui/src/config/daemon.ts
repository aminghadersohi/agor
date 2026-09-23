/**
 * Daemon configuration for UI
 *
 * Reads daemon URL from environment variables or uses defaults
 */

import { DAEMON } from '@agor-live/client';
import { daemonUrlForRuntime, resolveUiRuntime } from './urlRuntime';

/**
 * Get daemon URL for UI connections
 *
 * Reads from VITE_DAEMON_URL environment variable or falls back to default
 */
// Extend window interface for runtime config injection
interface WindowWithAgorConfig extends Window {
  AGOR_DAEMON_URL?: string;
}

export function getDaemonUrl(): string {
  // 1. Explicit config (env var or runtime injection)
  // Handles: production and any special setup
  if (typeof window !== 'undefined') {
    const injectedUrl = (window as WindowWithAgorConfig).AGOR_DAEMON_URL;
    if (injectedUrl) return injectedUrl;
  }

  const envUrl = import.meta.env.VITE_DAEMON_URL;
  if (envUrl) return envUrl;

  // 2. Same-host assumption: daemon runs on same host as UI
  // Use VITE_DAEMON_PORT if available, otherwise use default from constants
  const daemonPort = import.meta.env.VITE_DAEMON_PORT || String(DAEMON.DEFAULT_PORT);

  if (typeof window !== 'undefined') {
    const runtime = resolveUiRuntime({
      baseUrl: import.meta.env.BASE_URL,
      pathname: window.location.pathname,
    });
    return daemonUrlForRuntime(runtime, window.location.origin, daemonPort);
  }

  // 3. Server-side fallback
  return `http://${DAEMON.DEFAULT_HOST}:${daemonPort}`;
}

/**
 * Default daemon URL (for backwards compatibility)
 */
export const DEFAULT_DAEMON_URL = getDaemonUrl();

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Explain the one daemon-URL misconfiguration that cannot possibly work, so the
 * connection failure it causes is not reported as "the daemon isn't running".
 *
 * When `VITE_DAEMON_URL` is set to a loopback address but the UI is served from
 * some other host, `localhost` resolves to the *viewer's* machine, not the one
 * running the daemon. The daemon can be perfectly healthy and reachable — this
 * looks fine from the host that started it and fails only for everyone else,
 * which is exactly the case the generic "start the daemon" advice sends people
 * down the wrong path on.
 *
 * Deliberately a diagnostic and not a correction: a loopback daemon URL is
 * legitimate behind an SSH tunnel or port-forward, where localhost really is
 * the right address on the client. Overriding it would break those setups.
 *
 * Returns null when the combination is fine or cannot be judged.
 */
export function describeUnreachableDaemonOrigin(input: {
  daemonUrl: string;
  pageOrigin: string;
}): string | null {
  let daemonHost: string;
  let pageHost: string;
  try {
    daemonHost = new URL(input.daemonUrl).hostname;
    pageHost = new URL(input.pageOrigin).hostname;
  } catch {
    return null;
  }

  if (!isLoopbackHostname(daemonHost) || isLoopbackHostname(pageHost)) return null;

  return (
    `This page is served from ${pageHost}, but it is configured to reach the daemon at ` +
    `${input.daemonUrl}. On this machine that address means this machine, not the one running ` +
    `the daemon, so the request cannot arrive. Set VITE_DAEMON_URL to an address this browser ` +
    `can reach (or leave it unset to derive it from the page's own host). If you are using an ` +
    `SSH tunnel, forward the daemon port to this machine first.`
  );
}
