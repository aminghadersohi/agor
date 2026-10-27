import type { WebClient, WebClientOptions } from '@slack/web-api';
import { describe, expect, it } from 'vitest';
import { GatewayNotDispatchedError } from '../connector';
import { SlackConnector } from './slack';

/** Real pinned SDK, fake Axios adapter only: no sockets, tokens or provider calls. */
function transportFixture(
  mode:
    | 'lost_receipt'
    | 'rate_limited'
    | 'accepted'
    | 'auth_rejected'
    | 'internal_error' = 'lost_receipt'
) {
  let writes = 0;
  const adapter: WebClientOptions['adapter'] = async (config) => {
    writes++;
    if (mode === 'lost_receipt')
      throw Object.assign(new Error('offline receipt lost after simulated acceptance'), {
        code: 'ECONNRESET',
      });
    return {
      config,
      status: mode === 'rate_limited' ? 429 : 200,
      statusText: 'fixture',
      request: { path: '/api/chat.postMessage' },
      headers: mode === 'rate_limited' ? { 'retry-after': '1' } : {},
      data:
        mode === 'auth_rejected'
          ? { ok: false, error: 'invalid_auth' }
          : mode === 'internal_error'
            ? { ok: false, error: 'internal_error' }
            : { ok: true, ts: '123.456', channel: 'C123' },
    };
  };
  type Internals = {
    axios: { defaults: { adapter: WebClientOptions['adapter'] } };
    retryConfig: { retries: number; minTimeout?: number; maxTimeout?: number };
  };
  class OfflineConnector extends SlackConnector {
    constructor() {
      super({ bot_token: 'fixture', allowed_channel_ids: ['C123'] });
      const internal = (this as unknown as { web: WebClient }).web as unknown as Internals;
      expect(internal.retryConfig.retries).toBeGreaterThan(0);
      internal.retryConfig = { ...internal.retryConfig, retries: 1, minTimeout: 1, maxTimeout: 1 };
      internal.axios.defaults.adapter = adapter;
    }
    protected override createSingleAttemptWebClient(
      timeout: number,
      rejectRateLimitedCalls = false
    ): WebClient {
      const web = super.createSingleAttemptWebClient(timeout, rejectRateLimitedCalls);
      expect((web as unknown as Internals).retryConfig.retries).toBe(0);
      (web as unknown as Internals).axios.defaults.adapter = adapter;
      return web;
    }
  }
  return {
    connector: new OfflineConnector(),
    writes: () => writes,
  };
}

describe('schedule alert Slack transport policy', () => {
  it('one alert call never retransmits after a lost receipt at the real SDK boundary', async () => {
    const f = transportFixture();
    await expect(
      f.connector.sendDirectMessage({
        target: 'channel:C123',
        text: 'failure',
        singleAttempt: true,
        failureTaskId: 'task',
        failureScheduleId: 'schedule',
      })
    ).rejects.toThrow();
    expect(f.writes()).toBe(1);
  });
  it('does not globally disable ordinary Slack relay retries (counterfactual control)', async () => {
    const f = transportFixture();
    await expect(
      f.connector.sendDirectMessage({ target: 'channel:C123', text: 'ordinary' })
    ).rejects.toThrow();
    expect(f.writes()).toBe(2);
  });
  it('a rate-limit rejection is proven unsent, with no SDK rate-limit retransmission', async () => {
    const f = transportFixture('rate_limited');
    await expect(
      f.connector.sendDirectMessage({
        target: 'channel:C123',
        text: 'failure',
        singleAttempt: true,
      })
    ).rejects.toBeInstanceOf(GatewayNotDispatchedError);
    expect(f.writes()).toBe(1);
  });
  it('explicit authentication rejection is recoverable, but unknown platform effect stays ambiguous', async () => {
    for (const mode of ['auth_rejected', 'internal_error'] as const) {
      const f = transportFixture(mode);
      let caught: unknown;
      try {
        await f.connector.sendDirectMessage({
          target: 'channel:C123',
          text: 'failure',
          singleAttempt: true,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught instanceof GatewayNotDispatchedError).toBe(mode === 'auth_rejected');
      expect(f.writes()).toBe(1);
    }
  });
  it('keeps the returned receipt and does not perform optional post-send permalink IO', async () => {
    const f = transportFixture('accepted');
    expect(
      await f.connector.sendDirectMessage({
        target: 'channel:C123',
        text: 'failure',
        singleAttempt: true,
        failureTaskId: 'task',
        failureScheduleId: 'schedule',
      })
    ).toMatchObject({ messageId: '123.456' });
    expect(f.writes()).toBe(1);
  });
});
