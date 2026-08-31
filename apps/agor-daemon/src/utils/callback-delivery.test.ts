import { describe, expect, it } from 'vitest';
import {
  AUTO_CALLBACK_BTW_PAYLOAD_BYTES,
  CALLBACK_BTW_RESULT_MAX_BYTES,
  callbackPayloadBytes,
  decideCallbackDelivery,
  truncateCallbackBtwResult,
} from './callback-delivery.js';

describe('callback delivery policy', () => {
  it('keeps direct backward-compatible regardless of size or destination activity', () => {
    expect(
      decideCallbackDelivery({
        requested: 'direct',
        payload: 'x'.repeat(AUTO_CALLBACK_BTW_PAYLOAD_BYTES + 1),
        destinationBusy: true,
        callbackDigestSource: false,
      })
    ).toMatchObject({ requested: 'direct', resolved: 'direct' });
  });

  it('routes auto through BTW only for a busy destination or an 8 KiB rendered payload', () => {
    expect(
      decideCallbackDelivery({
        requested: 'auto',
        payload: 'short',
        destinationBusy: false,
        callbackDigestSource: false,
      })
    ).toMatchObject({ resolved: 'direct', fallback_reason: 'policy_direct' });
    expect(
      decideCallbackDelivery({
        requested: 'auto',
        payload: 'short',
        destinationBusy: true,
        callbackDigestSource: false,
      })
    ).toMatchObject({ resolved: 'btw' });
    expect(
      decideCallbackDelivery({
        requested: 'auto',
        payload: 'x'.repeat(AUTO_CALLBACK_BTW_PAYLOAD_BYTES),
        destinationBusy: false,
        callbackDigestSource: false,
      })
    ).toMatchObject({ resolved: 'btw' });
  });

  it('falls back explicitly when BTW is unavailable and never routes a digest recursively', () => {
    expect(
      decideCallbackDelivery({
        requested: 'btw',
        payload: 'report',
        destinationBusy: false,
        unavailableReason: 'permission_denied',
        callbackDigestSource: false,
      })
    ).toMatchObject({ resolved: 'direct', fallback_reason: 'permission_denied' });
    expect(
      decideCallbackDelivery({
        requested: 'btw',
        payload: 'report',
        destinationBusy: true,
        callbackDigestSource: true,
      })
    ).toMatchObject({ resolved: 'direct', fallback_reason: 'loop_guard' });
  });

  it('hard-caps multibyte digest output without corrupting UTF-8', () => {
    const result = truncateCallbackBtwResult('🙂'.repeat(CALLBACK_BTW_RESULT_MAX_BYTES));
    expect(callbackPayloadBytes(result)).toBeLessThanOrEqual(CALLBACK_BTW_RESULT_MAX_BYTES);
    expect(result).toContain('[Callback digest truncated by Agor]');
    expect(result).not.toContain('�');
  });
});
