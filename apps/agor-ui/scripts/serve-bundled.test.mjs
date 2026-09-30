// @vitest-environment node
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cacheControlFor,
  createBundledUiServer,
  isUiRequest,
  pickEncoding,
  resolveOptions,
  resolveUiFile,
  upstreamHeaders,
} from './serve-bundled.mjs';

let dist;

beforeAll(() => {
  dist = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agor-ui-dist-')));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>agor</title>');
  fs.writeFileSync(path.join(dist, 'favicon.png'), 'png');
  fs.writeFileSync(path.join(dist, 'assets', 'index-AbCdEf12.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dist, 'assets', 'index-AbCdEf12.js.gz'), 'gz-bytes');
  fs.writeFileSync(path.join(dist, 'assets', 'index-AbCdEf12.js.br'), 'br-bytes');
});

afterAll(() => {
  fs.rmSync(dist, { recursive: true, force: true });
});

describe('resolveOptions', () => {
  it('defaults to a local daemon and presents its own origin upstream', () => {
    const options = resolveOptions({});
    expect(options.port).toBe(5180);
    expect(options.host).toBe('0.0.0.0');
    expect(options.daemonUrl.href).toBe('http://127.0.0.1:3030/');
    expect(options.upstreamOrigin).toBe('http://localhost:3030');
    expect(options.dist.endsWith(`${path.sep}agor-ui${path.sep}dist`)).toBe(true);
  });

  it('derives the upstream origin from the daemon port', () => {
    expect(resolveOptions({ DAEMON_PORT: '4040' }).upstreamOrigin).toBe('http://localhost:4040');
    expect(resolveOptions({ DAEMON_URL: 'http://10.0.0.5:3131' }).upstreamOrigin).toBe(
      'http://localhost:3131'
    );
    expect(resolveOptions({ UPSTREAM_ORIGIN: 'https://agor.example.com' }).upstreamOrigin).toBe(
      'https://agor.example.com'
    );
  });
});

describe('isUiRequest', () => {
  it.each([
    ['/ui', true],
    ['/ui/', true],
    ['/ui/b/123', true],
    ['/ui?x=1', true],
    ['/uix', false],
    ['/socket.io/?EIO=4', false],
    ['/authentication', false],
  ])('%s -> %s', (url, expected) => {
    expect(isUiRequest(url)).toBe(expected);
  });
});

describe('resolveUiFile', () => {
  it('serves existing files and falls back to index.html for app routes', () => {
    expect(resolveUiFile(dist, '/ui/favicon.png')).toEqual({
      file: path.join(dist, 'favicon.png'),
    });
    expect(resolveUiFile(dist, '/ui/')).toEqual({ file: path.join(dist, 'index.html') });
    expect(resolveUiFile(dist, '/ui/b/some-board?x=1')).toEqual({
      file: path.join(dist, 'index.html'),
    });
  });

  it('404s a missing hashed asset instead of returning HTML', () => {
    expect(resolveUiFile(dist, '/ui/assets/gone-12345678.js')).toEqual({ status: 404 });
  });

  it('never escapes the dist directory', () => {
    for (const url of [
      '/ui/../../etc/passwd',
      '/ui/%2e%2e/%2e%2e/etc/passwd',
      '/ui/..%2f..%2fetc',
    ]) {
      const result = resolveUiFile(dist, url);
      if (result.file) expect(result.file.startsWith(dist)).toBe(true);
    }
    expect(resolveUiFile(dist, '/ui/%E0%A4%A')).toEqual({ status: 400 });
  });
});

describe('pickEncoding', () => {
  const file = () => path.join(dist, 'assets', 'index-AbCdEf12.js');

  it('prefers brotli, then gzip, then identity', () => {
    expect(pickEncoding(file(), 'gzip, deflate, br')).toEqual({
      path: `${file()}.br`,
      encoding: 'br',
    });
    expect(pickEncoding(file(), 'gzip')).toEqual({ path: `${file()}.gz`, encoding: 'gzip' });
    expect(pickEncoding(file(), '')).toEqual({ path: file(), encoding: undefined });
  });

  it('falls back when no precompressed sibling exists', () => {
    const png = path.join(dist, 'favicon.png');
    expect(pickEncoding(png, 'br, gzip')).toEqual({ path: png, encoding: undefined });
  });
});

describe('cacheControlFor', () => {
  it('caches hashed assets forever and revalidates everything else', () => {
    expect(cacheControlFor(dist, path.join(dist, 'assets', 'index-AbCdEf12.js'))).toContain(
      'immutable'
    );
    expect(cacheControlFor(dist, path.join(dist, 'index.html'))).toBe('no-cache');
    expect(cacheControlFor(dist, path.join(dist, 'favicon.png'))).toBe('no-cache');
  });
});

describe('upstreamHeaders', () => {
  const upstream = 'http://localhost:3030';

  it('rewrites a same-origin Origin to the daemon origin', () => {
    const headers = { host: '192.168.1.10:5180', origin: 'http://192.168.1.10:5180', a: 'b' };
    expect(upstreamHeaders(headers, upstream)).toEqual({ ...headers, origin: upstream });
  });

  it('forwards cross-origin, malformed, and absent Origins untouched', () => {
    const cross = { host: '192.168.1.10:5180', origin: 'https://evil.example' };
    expect(upstreamHeaders(cross, upstream)).toEqual(cross);
    const malformed = { host: '192.168.1.10:5180', origin: 'null' };
    expect(upstreamHeaders(malformed, upstream)).toEqual(malformed);
    const none = { host: '192.168.1.10:5180' };
    expect(upstreamHeaders(none, upstream)).toEqual(none);
  });
});

describe('createBundledUiServer', () => {
  let daemon;
  let server;
  let base;
  const seen = [];

  function listen(srv) {
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
  }

  beforeAll(async () => {
    daemon = http.createServer((req, res) => {
      seen.push({ url: req.url, origin: req.headers.origin });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    daemon.on('upgrade', (req, socket) => {
      seen.push({ url: req.url, origin: req.headers.origin, upgrade: true });
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
      );
      socket.on('data', (chunk) => socket.write(chunk));
      // HTTP server sockets are half-open; a real websocket peer ends its side too.
      socket.on('end', () => socket.end());
    });
    const daemonPort = await listen(daemon);
    const options = resolveOptions({ DAEMON_PORT: String(daemonPort), UI_DIST: dist });
    server = createBundledUiServer(options);
    base = `http://127.0.0.1:${await listen(server)}`;
  });

  afterAll(async () => {
    for (const srv of [server, daemon]) {
      srv.closeAllConnections();
      await new Promise((resolve) => srv.close(resolve));
    }
  });

  it('redirects the root to /ui/', async () => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ui/');
  });

  it('serves a precompressed hashed asset with immutable caching', async () => {
    const res = await new Promise((resolve) =>
      http.get(
        `${base}/ui/assets/index-AbCdEf12.js`,
        { headers: { 'accept-encoding': 'gzip' } },
        resolve
      )
    );
    res.resume();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['content-type']).toContain('text/javascript');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('serves index.html for deep links', async () => {
    const res = await fetch(`${base}/ui/b/some-board`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<title>agor</title>');
  });

  it('proxies API requests, presenting same-origin callers as the daemon origin', async () => {
    const host = new URL(base).host;
    const res = await fetch(`${base}/health`, { headers: { origin: `http://${host}` } });
    expect(await res.json()).toEqual({ ok: true });
    expect(seen.at(-1)).toEqual({ url: '/health', origin: resolveOptionsDaemonOrigin() });
  });

  it('proxies websocket upgrades and keeps a foreign Origin', async () => {
    const { port } = new URL(base);
    const socket = net.connect(Number(port), '127.0.0.1');
    const received = await new Promise((resolve, reject) => {
      let buffer = '';
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes('\r\n\r\n') && !buffer.endsWith('\r\n\r\n')) resolve(buffer);
        else if (buffer.endsWith('\r\n\r\n')) socket.write('ping');
      });
      socket.write(
        'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\nOrigin: https://evil.example\r\n` +
          'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
      );
    });
    socket.destroy();
    expect(received).toContain('101 Switching Protocols');
    expect(received.endsWith('ping')).toBe(true);
    expect(seen.at(-1)).toEqual({
      url: '/socket.io/?EIO=4&transport=websocket',
      origin: 'https://evil.example',
      upgrade: true,
    });
  });

  function resolveOptionsDaemonOrigin() {
    return `http://localhost:${daemon.address().port}`;
  }
});
