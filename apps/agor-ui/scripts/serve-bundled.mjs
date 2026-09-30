#!/usr/bin/env node
/**
 * Serves the production UI bundle (apps/agor-ui/dist) at /ui and proxies every
 * other request — REST, /authentication, socket.io (including the websocket
 * upgrade), OAuth callbacks, /health — to the daemon.
 *
 * Why: the Vite dev server serves hundreds of unbundled modules, one request
 * each. Over a high-latency link (VPN, mobile) the page never finishes loading
 * and sits on "Reconnecting to daemon". This gives the same shape as an
 * installed Agor (UI and API on one origin, a few hashed chunks, precompressed,
 * cached forever) without packaging the daemon.
 *
 * The bundle is a snapshot: rebuild it (`pnpm --filter agor-ui build`) after
 * pulling or deploying new UI code, or this keeps serving the old one.
 *
 * Environment:
 *   PORT             listen port                       (default 5180)
 *   HOST             listen address                    (default 0.0.0.0)
 *   DAEMON_URL       daemon base URL                   (default http://127.0.0.1:$DAEMON_PORT)
 *   DAEMON_PORT      daemon port when DAEMON_URL unset (default 3030)
 *   UI_DIST          built UI directory                (default ../dist)
 *   UPSTREAM_ORIGIN  Origin sent upstream for same-origin requests
 *                    (default http://localhost:<daemon port>)
 *
 * Origin handling: the browser sees this server as the page origin, which the
 * daemon's CORS list does not know. A request whose Origin matches its own Host
 * is same-origin by definition, so it is presented to the daemon as coming from
 * the daemon's own origin — the same Origin a daemon-served /ui would send, and
 * one the daemon always allows. Any other Origin is forwarded untouched, so
 * cross-origin requests (including websocket handshakes, which browsers do not
 * CORS-check) still get the daemon's own verdict.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Mirrors UI_MOUNT_PATH in @agor/core; the production bundle is built with base '/ui/'. */
export const UI_MOUNT_PATH = '/ui';

const ONE_YEAR_SECONDS = 31_536_000;

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Resolve server options from environment variables. */
export function resolveOptions(env = process.env) {
  const daemonUrl = new URL(env.DAEMON_URL || `http://127.0.0.1:${env.DAEMON_PORT || 3030}`);
  const daemonPort = Number(daemonUrl.port || (daemonUrl.protocol === 'https:' ? 443 : 80));
  const defaultDist = fileURLToPath(new URL('../dist', import.meta.url));
  return {
    port: Number(env.PORT || 5180),
    host: env.HOST || '0.0.0.0',
    daemonUrl,
    dist: path.resolve(env.UI_DIST || defaultDist),
    // The daemon's CORS list always includes http://localhost:<daemon port>.
    upstreamOrigin: env.UPSTREAM_ORIGIN || `http://localhost:${daemonPort}`,
  };
}

/** True when `url` addresses the bundled UI rather than the daemon. */
export function isUiRequest(url) {
  return (
    url === UI_MOUNT_PATH ||
    url.startsWith(`${UI_MOUNT_PATH}/`) ||
    url.startsWith(`${UI_MOUNT_PATH}?`)
  );
}

/**
 * Map a /ui request URL to a file under `dist`.
 * Returns `{ status: 400 | 403 | 404 }` for unservable requests, otherwise
 * `{ file }`. Unknown app routes fall back to index.html (client-side routing);
 * a missing file under assets/ is a real 404, not HTML posing as a chunk.
 */
export function resolveUiFile(dist, url) {
  let rel;
  try {
    rel = decodeURIComponent(new URL(url, 'http://localhost').pathname).slice(UI_MOUNT_PATH.length);
  } catch {
    return { status: 400 };
  }
  const file = path.resolve(dist, `.${path.posix.normalize(`/${rel}`)}`);
  if (file !== dist && !file.startsWith(`${dist}${path.sep}`)) return { status: 403 };

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    // ENOENT, ENOTDIR, or a name the filesystem rejects (e.g. a NUL byte).
  }
  if (stat?.isFile()) return { file };
  if (path.relative(dist, file).split(path.sep)[0] === 'assets') return { status: 404 };
  return { file: path.join(dist, 'index.html') };
}

/** Pick a precompressed sibling (.br, then .gz) the client accepts, if one exists. */
export function pickEncoding(file, acceptEncoding = '') {
  for (const [token, ext] of [
    ['br', '.br'],
    ['gzip', '.gz'],
  ]) {
    if (new RegExp(`\\b${token}\\b`).test(acceptEncoding) && fs.existsSync(file + ext)) {
      return { path: file + ext, encoding: token };
    }
  }
  return { path: file, encoding: undefined };
}

/** Hashed build output is immutable; everything else (index.html, public/) revalidates. */
export function cacheControlFor(dist, file) {
  const inAssets = path.relative(dist, file).split(path.sep)[0] === 'assets';
  return inAssets ? `public, max-age=${ONE_YEAR_SECONDS}, immutable` : 'no-cache';
}

/**
 * Headers to send upstream. A same-origin Origin (matching the request's own
 * Host) is replaced with `upstreamOrigin`; anything else passes through.
 */
export function upstreamHeaders(headers, upstreamOrigin) {
  const out = { ...headers };
  const { origin, host } = headers;
  if (typeof origin === 'string' && typeof host === 'string') {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = undefined;
    }
    if (originHost === host) out.origin = upstreamOrigin;
  }
  return out;
}

function serveUi(options, req, res) {
  const resolved = resolveUiFile(options.dist, req.url);
  if (!resolved.file) {
    res.writeHead(resolved.status).end();
    return;
  }
  const { file } = resolved;
  const send = pickEncoding(file, String(req.headers['accept-encoding'] || ''));
  let size;
  try {
    size = fs.statSync(send.path).size;
  } catch {
    // index.html itself is missing: the bundle has not been built.
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`UI bundle not found in ${options.dist}. Run: pnpm --filter agor-ui build\n`);
    return;
  }
  const headers = {
    'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': cacheControlFor(options.dist, file),
    Vary: 'Accept-Encoding',
  };
  if (send.encoding) headers['Content-Encoding'] = send.encoding;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(send.path).pipe(res);
}

function proxyHttp(options, req, res) {
  const { daemonUrl, upstreamOrigin } = options;
  const upstream = http.request(
    {
      host: daemonUrl.hostname,
      port: daemonUrl.port || 80,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req.headers, upstreamOrigin),
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.rawHeaders);
      upstreamRes.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

function proxyUpgrade(options, req, socket, head) {
  const { daemonUrl, upstreamOrigin } = options;
  const upstream = net.connect(Number(daemonUrl.port || 80), daemonUrl.hostname, () => {
    const headerLines = Object.entries(upstreamHeaders(req.headers, upstreamOrigin)).flatMap(
      ([name, value]) => (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`)
    );
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  // Either side going away (error, reset, or a clean close) tears down the other.
  upstream.on('close', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

/** Build (but do not start) the server. */
export function createBundledUiServer(options) {
  if (options.daemonUrl.protocol !== 'http:') {
    throw new Error(`DAEMON_URL must be http:// (got ${options.daemonUrl.href})`);
  }
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url === '/') {
      res.writeHead(302, { Location: `${UI_MOUNT_PATH}/` }).end();
    } else if (isUiRequest(url)) {
      serveUi(options, req, res);
    } else {
      proxyHttp(options, req, res);
    }
  });
  server.on('upgrade', (req, socket, head) => proxyUpgrade(options, req, socket, head));
  // Outlive typical client/load-balancer idle timeouts so keep-alive sockets
  // are not dropped mid-reuse on slow links.
  server.keepAliveTimeout = 65_000;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const options = resolveOptions();
  if (!fs.existsSync(path.join(options.dist, 'index.html'))) {
    console.warn(`⚠️  No UI bundle at ${options.dist} — run: pnpm --filter agor-ui build`);
  }
  createBundledUiServer(options).listen(options.port, options.host, () => {
    console.log(
      `Agor bundled UI on http://${options.host}:${options.port}${UI_MOUNT_PATH}/ -> ${options.daemonUrl.origin}`
    );
  });
}
