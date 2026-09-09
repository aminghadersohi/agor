import { describe, expect, it } from 'vitest';
import { normalizeDisplayTimezone, normalizeReminderInstant } from './session-memory';

describe('Session reminder instant validation', () => {
  const now = Date.parse('2026-03-08T06:00:00.000Z');

  it('stores an explicit UTC instant independent of DST display timezone', () => {
    expect(normalizeReminderInstant('2026-03-08T07:30:00Z', now)).toBe('2026-03-08T07:30:00.000Z');
    expect(normalizeDisplayTimezone('America/New_York')).toBe('America/New_York');
  });

  it('rejects ambiguous local times and invalid timezones', () => {
    expect(() => normalizeReminderInstant('2026-11-01T01:30:00', now)).toThrow('ending in Z');
    expect(() => normalizeDisplayTimezone('Mars/Olympus_Mons')).toThrow('recognized IANA');
  });

  it('enforces the minimum lead and maximum horizon', () => {
    expect(() => normalizeReminderInstant('2026-03-08T06:00:30Z', now)).toThrow('60 seconds');
    expect(() => normalizeReminderInstant('2028-03-08T06:00:00Z', now)).toThrow('one year');
  });
});
