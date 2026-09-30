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

vi.mock('./TeammatePhotoScreensaver', () => ({
  default: ({
    reducedMotion,
    onUnavailable,
  }: {
    reducedMotion: boolean;
    onUnavailable: () => void;
  }) => (
    <button type="button" data-reduced-motion={String(reducedMotion)} onClick={onUnavailable}>
      teammate slideshow
    </button>
  ),
}));

const motionPreference = { matches: false };
const TEAMMATES = [{ id: 'lagertha', name: 'Lagertha' }];

/** Resolve the lazy slideshow import; `findBy*` polling stalls under fake timers. */
async function settleLazyImport() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      await vi.dynamicImportSettled();
    });
  }
}

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

  it('shows the lazily loaded teammate slideshow when teammates exist', async () => {
    render(<IdleGlyphScreensaver idleMs={1_000} teammates={TEAMMATES} />);
    act(() => vi.advanceTimersByTime(1_000));
    await settleLazyImport();
    expect(screen.getByText('teammate slideshow')).toBeInTheDocument();
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('falls back to the signal field when no teammate photo can be shown', async () => {
    render(<IdleGlyphScreensaver idleMs={1_000} teammates={TEAMMATES} />);
    act(() => vi.advanceTimersByTime(1_000));
    await settleLazyImport();
    const slideshow = screen.getByText('teammate slideshow');
    fireEvent.click(slideshow);
    expect(screen.queryByText('teammate slideshow')).not.toBeInTheDocument();
    expect(document.querySelector('canvas')).not.toBeNull();
  });

  it('uses the signal field when that style is chosen, even with teammates', () => {
    render(<IdleGlyphScreensaver idleMs={1_000} style="signal-field" teammates={TEAMMATES} />);
    act(() => vi.advanceTimersByTime(1_000));
    expect(document.querySelector('canvas')).not.toBeNull();
  });

  it('runs the slideshow in reduced-motion mode, and exits if it has no photos', async () => {
    motionPreference.matches = true;
    render(<IdleGlyphScreensaver idleMs={1_000} teammates={TEAMMATES} />);
    act(() => vi.advanceTimersByTime(1_000));
    await settleLazyImport();
    const slideshow = screen.getByText('teammate slideshow');
    expect(slideshow).toHaveAttribute('data-reduced-motion', 'true');

    fireEvent.click(slideshow);
    expect(screen.queryByRole('dialog', { name: /idle screensaver/i })).not.toBeInTheDocument();
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
