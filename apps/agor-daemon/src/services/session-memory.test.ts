import { describe, expect, it } from 'vitest';
import {
  normalizeCheckEveryMinutes,
  normalizeDisplayTimezone,
  normalizeReminderInstant,
  normalizeWakeCondition,
} from './session-memory';

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

describe('Session reminder wake-condition validation', () => {
  const valid = { kind: 'github_pr', repo: 'acme/widgets.js', number: 284, state: 'closed' };

  it('accepts a GitHub pull request condition', () => {
    expect(normalizeWakeCondition(valid)).toEqual(valid);
  });

  it.each([
    ['a missing body', null],
    ['an unknown kind', { ...valid, kind: 'github_issue' }],
    ['an unknown state', { ...valid, state: 'approved' }],
    ['a repo without an owner', { ...valid, repo: 'widgets' }],
    ['a repo path traversal', { ...valid, repo: 'acme/..' }],
    ['a repo with extra segments', { ...valid, repo: 'acme/widgets/pulls' }],
    ['a fractional number', { ...valid, number: 1.5 }],
    ['a zero number', { ...valid, number: 0 }],
    ['a string number', { ...valid, number: '284' }],
    ['extra fields', { ...valid, token: 'ghp_fictional' }],
  ])('rejects %s', (_label, value) => {
    expect(() => normalizeWakeCondition(value)).toThrow(/wake_when/);
  });

  it('bounds the check cadence to 5-60 whole minutes', () => {
    expect(normalizeCheckEveryMinutes(5)).toBe(5);
    expect(normalizeCheckEveryMinutes(60)).toBe(60);
    for (const value of [4, 61, 7.5, '10', undefined]) {
      expect(() => normalizeCheckEveryMinutes(value)).toThrow(/check_every_minutes/);
    }
  });
});
