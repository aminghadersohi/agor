import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SCREENSAVER_IDLE_MINUTES,
  DEFAULT_SCREENSAVER_IDLE_MS,
  IdleGlyphScreensaver,
  MAX_SCREENSAVER_IDLE_MINUTES,
  MIN_SCREENSAVER_IDLE_MINUTES,
  resolveScreensaverIdleMinutes,
  startIdleGlyphScreensaver,
} from './IdleGlyphScreensaver';

const motionPreference = { matches: false };

describe('IdleGlyphScreensaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    motionPreference.matches = false;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: motionPreference.matches,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('appears after the idle deadline and wakes on activity', () => {
    render(<IdleGlyphScreensaver />);
    expect(screen.queryByRole('dialog', { name: /idle screensaver/i })).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(DEFAULT_SCREENSAVER_IDLE_MS));
    expect(screen.getByRole('dialog', { name: /idle screensaver/i })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /idle screensaver/i })).not.toBeInTheDocument();
  });

  it('resets the idle deadline when the user is active', () => {
    render(<IdleGlyphScreensaver idleMs={1_000} />);
    act(() => vi.advanceTimersByTime(800));
    fireEvent.wheel(window);
    act(() => vi.advanceTimersByTime(800));
    expect(screen.queryByRole('dialog', { name: /idle screensaver/i })).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole('dialog', { name: /idle screensaver/i })).toBeInTheDocument();
  });

  it('does not activate when reduced motion is requested', () => {
    motionPreference.matches = true;
    render(<IdleGlyphScreensaver idleMs={1_000} />);
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByRole('dialog', { name: /idle screensaver/i })).not.toBeInTheDocument();
  });

  it('can be previewed immediately', () => {
    render(<IdleGlyphScreensaver />);
    act(() => startIdleGlyphScreensaver());
    expect(screen.getByRole('dialog', { name: /idle screensaver/i })).toBeInTheDocument();
  });

  it('never starts on idle when automatic activation is off, but can still be previewed', () => {
    render(<IdleGlyphScreensaver idleMs={1_000} idleEnabled={false} />);
    act(() => vi.advanceTimersByTime(DEFAULT_SCREENSAVER_IDLE_MS * 2));
    expect(screen.queryByRole('dialog', { name: /idle screensaver/i })).not.toBeInTheDocument();

    act(() => startIdleGlyphScreensaver());
    expect(screen.getByRole('dialog', { name: /idle screensaver/i })).toBeInTheDocument();
  });

  it('clamps the stored idle delay to the supported range', () => {
    expect(resolveScreensaverIdleMinutes(undefined)).toBe(DEFAULT_SCREENSAVER_IDLE_MINUTES);
    expect(resolveScreensaverIdleMinutes({ enabled: true })).toBe(DEFAULT_SCREENSAVER_IDLE_MINUTES);
    expect(resolveScreensaverIdleMinutes({ enabled: true, idleMinutes: 0 })).toBe(
      MIN_SCREENSAVER_IDLE_MINUTES
    );
    expect(resolveScreensaverIdleMinutes({ enabled: true, idleMinutes: 10_000 })).toBe(
      MAX_SCREENSAVER_IDLE_MINUTES
    );
    expect(resolveScreensaverIdleMinutes({ enabled: true, idleMinutes: 12.4 })).toBe(12);
  });
});
