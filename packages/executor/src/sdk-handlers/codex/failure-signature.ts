const NATIVE_FAILURE_MESSAGES = {
  rate_limit_exhausted:
    'Codex exhausted its retries after HTTP 429 (Too Many Requests). Wait before trying again; review any output and tool activity before retrying. This does not establish an authentication or billing problem.',
  model_capacity:
    'Codex reported that the selected model is at capacity. Wait before trying again; review any output and tool activity before retrying.',
} as const;

/** Provider-local evidence; never credential remediation or replay authority. */
export class CodexNativeFailureError extends Error {
  constructor(readonly failureCode: keyof typeof NATIVE_FAILURE_MESSAGES) {
    super(NATIVE_FAILURE_MESSAGES[failureCode]);
    this.name = 'CodexNativeFailureError';
  }
}

/**
 * Codex exec 0.160.0 drops codexErrorInfo from its JSONL ThreadError. These
 * exact native Display strings are a narrow compatibility bridge, not general
 * provider-prose parsing. Never return the message, inspect nested causes, or
 * infer that replay is safe. Unknown/extended messages stay opaque.
 */
export function codexFailureSignature(
  error: unknown
): 'rate_limit_exhausted' | 'model_capacity' | undefined {
  try {
    if (error === null || typeof error !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    const message = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (message === 'exceeded retry limit, last status: 429 Too Many Requests') {
      return 'rate_limit_exhausted';
    }
    if (message === 'Selected model is at capacity. Please try a different model.') {
      return 'model_capacity';
    }
  } catch {
    // External objects must not turn diagnostics into a second failure.
  }
  return undefined;
}
