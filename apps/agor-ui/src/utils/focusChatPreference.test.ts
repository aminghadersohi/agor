import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readFocusChatPreference,
  subscribeToFocusChatPreference,
  writeFocusChatPreference,
} from './focusChatPreference';

describe('focus chat preference', () => {
  afterEach(() => localStorage.clear());

  it('persists and notifies same-window consumers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToFocusChatPreference(listener);

    writeFocusChatPreference(true);

    expect(readFocusChatPreference()).toBe(true);
    expect(listener).toHaveBeenCalledWith(true);
    unsubscribe();
  });
});
