import type { AgorClient, PowerManagementStatus } from '@agor-live/client';
import { Alert } from 'antd';
import { useEffect, useState } from 'react';

export interface PowerStatusBannerProps {
  client: AgorClient;
}

const LABELS: Record<PowerManagementStatus['state'], string> = {
  disabled: 'UPS power policy disabled',
  unknown: 'UPS power status unavailable',
  normal: 'UPS power policy normal',
  conserve: 'UPS conservation active',
  critical: 'UPS battery critical',
  recovering: 'Utility power recovery',
};

export function PowerStatusBanner({ client }: PowerStatusBannerProps) {
  const [status, setStatus] = useState<PowerManagementStatus | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const service = client.service('power-management');
    const accept = (next: PowerManagementStatus) => {
      if (cancelled) return;
      setStatus(next);
      setReceivedAt(performance.now());
    };
    void service
      .find()
      .then(accept)
      .catch(() => undefined);
    service.on('patched', accept);
    return () => {
      cancelled = true;
      service.off('patched', accept);
    };
  }, [client]);

  useEffect(() => {
    if (!status || status.state === 'disabled') return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [status]);

  const description = (() => {
    if (!status) return undefined;
    const observe = status.mode === 'observe' ? 'Observe mode only; dispatch is not gated. ' : '';
    const elapsed = Math.max(0, performance.now() - receivedAt);
    const observationAge =
      status.observation_age_ms === undefined ? undefined : status.observation_age_ms + elapsed;
    const age =
      status.observation_age_ms === undefined
        ? 'No observation available.'
        : `Observation ${status.freshness}, ${Math.ceil((observationAge ?? 0) / 1_000)}s old; reason: ${status.reason.replaceAll('_', ' ')}.`;
    if (status.state === 'disabled') return 'Opt in with execution.power_management.mode.';
    if (status.state === 'normal') return `${observe}New work is admitted normally. ${age}`;
    if (status.state === 'conserve') {
      return `${observe}Ordinary queued work is held; existing running work finishes. Essential Sessions may start. ${age}`;
    }
    if (status.state === 'critical') {
      return `${observe}No new work starts, including essential Sessions. Running work is not stopped. ${age}`;
    }
    if (status.state === 'recovering') {
      const remaining = Math.max(0, (status.recovery_remaining_ms ?? 0) - elapsed);
      return `${observe}Online stability is being verified; ordinary dispatch resumes in about ${Math.ceil(remaining / 1_000)}s, then proceeds at a paced rate. ${age}`;
    }
    return `${observe}New work is held until a trustworthy power reading is available. ${age}`;
  })();

  if (!status) return null;
  const type =
    status.state === 'critical'
      ? 'error'
      : status.state === 'conserve' || status.state === 'unknown'
        ? 'warning'
        : 'info';
  return (
    <Alert
      type={type}
      showIcon
      title={`${LABELS[status.state]}${status.mode === 'observe' ? ' (Observe)' : ''}`}
      description={description}
      role="status"
      aria-live={status.state === 'critical' ? 'assertive' : 'polite'}
      style={{ marginBlockEnd: 8 }}
    />
  );
}
