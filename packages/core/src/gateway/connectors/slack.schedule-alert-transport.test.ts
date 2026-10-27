import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertNoEgress } from '../../test/no-egress';

// The provider module is NEVER imported/instantiated: every client is this inert stub.
const transport = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  post: vi.fn(),
  permalink: vi.fn(),
}));
vi.mock('@slack/web-api', () => ({
  default: { retryPolicies: { fiveRetriesInFiveMinutes: { retries: 5 } } },
  WebClient: class {
    chat = { postMessage: transport.post, getPermalink: transport.permalink };
    constructor(_token: string, options: Record<string, unknown>) {
      transport.options.push(options);
    }
  },
}));
vi.mock('@slack/socket-mode', () => ({
  LogLevel: { DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error' },
  SocketModeClient: class {},
}));

import { GatewayNotDispatchedError } from '../connector';
import { SlackConnector } from './slack';

beforeEach(() => {
  assertNoEgress();
  transport.options.length = 0;
  transport.post.mockReset();
  transport.permalink.mockReset();
});
function fixture() {
  return new SlackConnector({ bot_token: 'inert', allowed_channel_ids: ['C123'] });
}
const request = {
  target: 'channel:C123',
  text: 'failure',
  singleAttempt: true,
  failureTaskId: 'task',
  failureScheduleId: 'schedule',
  failureAttemptId: 'attempt',
};
describe('schedule alert transport policy (injected transport only)', () => {
  it('forwards one post and bounded no-retry options after an ambiguous transport effect', async () => {
    const connector = fixture();
    transport.post.mockRejectedValueOnce(new Error('inert lost receipt'));
    await expect(connector.sendDirectMessage(request)).rejects.toThrow();
    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(transport.options[1]).toMatchObject({
      timeout: 15_000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    });
    expect(transport.permalink).not.toHaveBeenCalled();
    assertNoEgress();
  });
  it('does not alter the ordinary relay client retry policy', async () => {
    const connector = fixture();
    transport.post.mockResolvedValue({ ok: true, ts: '123.456' });
    transport.permalink.mockResolvedValue({ ok: true, permalink: 'https://example.invalid' });
    await connector.sendDirectMessage({ target: 'channel:C123', text: 'ordinary' });
    expect(transport.options).toEqual([expect.objectContaining({ retryConfig: { retries: 5 } })]);
    assertNoEgress();
  });
  it.each(['slack_webapi_rate_limited_error', 'slack_webapi_platform_error'])(
    'typed explicit nonacceptance: %s',
    async (code) => {
      const connector = fixture();
      transport.post.mockRejectedValueOnce({ code, data: { error: 'invalid_auth' } });
      await expect(connector.sendDirectMessage(request)).rejects.toBeInstanceOf(
        GatewayNotDispatchedError
      );
      expect(transport.post).toHaveBeenCalledTimes(1);
    }
  );
  it('unknown platform effect stays ambiguous, with no fallback', async () => {
    const connector = fixture();
    transport.post.mockRejectedValueOnce({
      code: 'slack_webapi_platform_error',
      data: { error: 'internal_error' },
    });
    let caught: unknown;
    try {
      await connector.sendDirectMessage({ ...request, blocks: [{ type: 'section' }] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(GatewayNotDispatchedError);
    expect(transport.post).toHaveBeenCalledTimes(1);
  });
  it('preserves receipt and exact attempt metadata without optional follow-up IO', async () => {
    const connector = fixture();
    transport.post.mockResolvedValueOnce({ ok: true, ts: '123.456' });
    expect(await connector.sendDirectMessage(request)).toMatchObject({ messageId: '123.456' });
    expect(transport.post).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          event_type: 'agor_schedule_failure',
          event_payload: { task_id: 'task', schedule_id: 'schedule', attempt_id: 'attempt' },
        },
      })
    );
    expect(transport.permalink).not.toHaveBeenCalled();
    assertNoEgress();
  });
});
