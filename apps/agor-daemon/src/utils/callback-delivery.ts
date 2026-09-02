import type { CallbackDelivery } from '@agor/core/types';

/** Auto uses BTW once the rendered callback is at least 8 KiB. */
export const AUTO_CALLBACK_BTW_PAYLOAD_BYTES = 8 * 1024;

/** A callback-digest answer is bounded before it enters the coordinator transcript. */
export const CALLBACK_BTW_RESULT_MAX_BYTES = 4 * 1024;

/** Availability is determined before attempting a fork; operational failures are separate. */
export type CallbackBtwUnavailableReason =
  | 'unsupported_agent'
  | 'missing_fork_state'
  | 'destination_inactive'
  | 'branch_inactive'
  | 'permission_denied';

export type CallbackDeliveryFallbackReason =
  | CallbackBtwUnavailableReason
  | 'loop_guard'
  | 'policy_direct'
  | 'creation_failed';

export interface CallbackDeliveryDecision {
  requested: CallbackDelivery;
  resolved: 'direct' | 'btw';
  payload_bytes: number;
  destination_busy: boolean;
  fallback_reason?: CallbackDeliveryFallbackReason;
}

export function callbackPayloadBytes(payload: string): number {
  return new TextEncoder().encode(payload).byteLength;
}

/**
 * Deterministic callback-delivery policy. There is no model-based routing:
 * auto attempts BTW exactly when the destination is busy or the already
 * rendered callback is at least {@link AUTO_CALLBACK_BTW_PAYLOAD_BYTES}.
 */
export function decideCallbackDelivery(input: {
  requested?: CallbackDelivery;
  payload: string;
  destinationBusy: boolean;
  unavailableReason?: CallbackBtwUnavailableReason;
  callbackDigestSource: boolean;
}): CallbackDeliveryDecision {
  const requested = input.requested ?? 'direct';
  const payloadBytes = callbackPayloadBytes(input.payload);

  if (input.callbackDigestSource) {
    return {
      requested,
      resolved: 'direct',
      payload_bytes: payloadBytes,
      destination_busy: input.destinationBusy,
      fallback_reason: 'loop_guard',
    };
  }

  const policyWantsBtw =
    requested === 'btw' ||
    (requested === 'auto' &&
      (input.destinationBusy || payloadBytes >= AUTO_CALLBACK_BTW_PAYLOAD_BYTES));
  if (!policyWantsBtw) {
    return {
      requested,
      resolved: 'direct',
      payload_bytes: payloadBytes,
      destination_busy: input.destinationBusy,
      ...(requested === 'auto' ? { fallback_reason: 'policy_direct' as const } : {}),
    };
  }

  if (input.unavailableReason) {
    return {
      requested,
      resolved: 'direct',
      payload_bytes: payloadBytes,
      destination_busy: input.destinationBusy,
      fallback_reason: input.unavailableReason,
    };
  }

  return {
    requested,
    resolved: 'btw',
    payload_bytes: payloadBytes,
    destination_busy: input.destinationBusy,
  };
}

/** UTF-8-safe hard cap used even if the digesting model ignores its prompt. */
export function truncateCallbackBtwResult(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= CALLBACK_BTW_RESULT_MAX_BYTES) return text;
  const suffix = '\n\n[Callback digest truncated by Agor]';
  const suffixBytes = new TextEncoder().encode(suffix).byteLength;
  const budget = Math.max(0, CALLBACK_BTW_RESULT_MAX_BYTES - suffixBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let end = budget;
  while (end > 0) {
    try {
      return `${decoder.decode(bytes.slice(0, end))}${suffix}`;
    } catch {
      end -= 1;
    }
  }
  return suffix.slice(-CALLBACK_BTW_RESULT_MAX_BYTES);
}
