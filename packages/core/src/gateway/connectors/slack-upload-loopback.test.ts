import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { WebClient } from '@slack/web-api';
import { expect, it } from 'vitest';
import { SlackConnector } from './slack';

it('reads the file id from the real @slack/web-api uploadV2 response shape', async () => {
  // uploadV2 is a three-step SDK helper whose result nests each
  // files.completeUploadExternal response: `{ ok, files: [{ ok, files: [...] }] }`.
  // Drive the real WebClient against a fake Slack API so that nesting is the
  // SDK's, not a hand-written mock's.
  const requests: Array<{ path: string; body: Buffer }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      requests.push({ path, body: Buffer.concat(chunks) });
      const { port } = server.address() as AddressInfo;
      res.setHeader('Content-Type', 'application/json');
      if (path === '/api/files.getUploadURLExternal') {
        res.end(
          JSON.stringify({
            ok: true,
            upload_url: `http://127.0.0.1:${port}/upload/F0IMAGE`,
            file_id: 'F0IMAGE',
          })
        );
      } else if (path === '/upload/F0IMAGE') {
        res.setHeader('Content-Type', 'text/plain');
        res.end('OK - 9');
      } else if (path === '/api/files.completeUploadExternal') {
        res.end(JSON.stringify({ ok: true, files: [{ id: 'F0IMAGE', title: 'chart.png' }] }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: 'unknown_method' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const connector = new SlackConnector({ bot_token: 'xoxb-test' });
    (connector as unknown as { web: WebClient }).web = new WebClient('xoxb-test', {
      slackApiUrl: `http://127.0.0.1:${port}/api/`,
      retryConfig: { retries: 0 },
    });

    const result = await connector.uploadFile({
      channel: 'C123',
      threadTs: '1700000000.000001',
      file: Readable.from([Buffer.from('png-bytes')]),
      filename: 'chart.png',
    });

    expect(result).toEqual({ id: 'F0IMAGE', permalink: null, name: 'chart.png' });
    expect(requests.map((r) => r.path)).toEqual([
      '/api/files.getUploadURLExternal',
      '/upload/F0IMAGE',
      '/api/files.completeUploadExternal',
    ]);
    expect(requests[1]?.body.toString()).toContain('png-bytes');
    const complete = new URLSearchParams(requests[2]?.body.toString());
    expect(complete.get('channel_id')).toBe('C123');
    expect(complete.get('thread_ts')).toBe('1700000000.000001');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
