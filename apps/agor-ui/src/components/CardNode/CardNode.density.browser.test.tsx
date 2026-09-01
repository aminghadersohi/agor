/**
 * Real-browser guard for the honest board-density capability boundary.
 *
 * Run: pnpm vitest run --config vitest.browser.config.ts
 */
import type { CardWithType } from '@agor-live/client';
import { cleanup, render, screen } from '@testing-library/react';
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
  it('keeps all card content visible and exposes no density hit target', () => {
    render(<CardNode data={{ card: makeCard() }} />);

    expect(screen.getByText(/welcome step still reads/)).toBeTruthy();
    expect(screen.getByText(/Blocked on the copy review/)).toBeTruthy();
    expect(screen.queryByLabelText('Collapse card')).toBeNull();
    expect(screen.queryByLabelText('Expand card')).toBeNull();

    const title = screen.getByText('Refine onboarding copy');
    expect(title.getBoundingClientRect().width).toBeGreaterThan(100);
  });
});
