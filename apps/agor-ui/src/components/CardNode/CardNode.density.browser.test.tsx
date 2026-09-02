/**
 * Real-browser guard for the honest board-density capability boundary.
 *
 * Run: pnpm vitest run --config vitest.browser.config.ts
 */
import type { CardWithType } from '@agor-live/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import CardNode from './CardNode';

afterEach(cleanup);

function makeCard(): CardWithType {
  return {
    card_id: 'card-1',
    title: 'Refine onboarding copy',
    description:
      'The welcome step still reads like internal jargon. Rewrite it around a new teammate.',
    note: 'Blocked on the copy review going out Thursday.',
    effective_emoji: '📝',
    archived: false,
  } as unknown as CardWithType;
}

describe('CardNode density capability (real browser)', () => {
  it('measures a smaller real DOM rectangle after hiding the lower body', () => {
    const { rerender } = render(
      <CardNode data={{ card: makeCard(), onToggleCompact: () => undefined }} />
    );

    expect(screen.getByText(/welcome step still reads/)).toBeTruthy();
    expect(screen.getByText(/Blocked on the copy review/)).toBeTruthy();
    const title = screen.getByText('Refine onboarding copy');
    const expandedHeight = title.closest('[style*="width: 380px"]')?.getBoundingClientRect().height;
    fireEvent.click(screen.getByLabelText('Collapse card'));
    rerender(
      <CardNode data={{ card: makeCard(), compact: true, onToggleCompact: () => undefined }} />
    );

    const compactHeight = title.closest('[style*="width: 380px"]')?.getBoundingClientRect().height;
    expect(screen.queryByText(/welcome step still reads/)).toBeNull();
    expect(screen.queryByText(/Blocked on the copy review/)).toBeNull();
    expect(compactHeight).toBeLessThan(expandedHeight ?? 0);
    expect(title.getBoundingClientRect().width).toBeGreaterThan(100);
  });
});
