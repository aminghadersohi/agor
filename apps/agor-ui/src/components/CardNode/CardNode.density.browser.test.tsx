/**
 * Real-browser (Playwright + Chromium) checks for the board density controls.
 *
 * jsdom reports every element as 0×0, so the claims this PR actually makes
 * about collapsing — that a collapsed card is *shorter*, that collapsed cards
 * don't overlap, and that the header control stays a real, legible hit target
 * once the body is hidden — can only be observed in a browser that lays out.
 *
 * Run: pnpm vitest run --config vitest.browser.config.ts
 */
import type { CardWithType } from '@agor-live/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import CardNode from './CardNode';

afterEach(cleanup);

function makeCard(over: Partial<CardWithType> = {}): CardWithType {
  return {
    card_id: 'card-1',
    title: 'Refine onboarding copy',
    description:
      'The welcome step still reads like internal jargon. Rewrite it around what a new teammate is actually trying to do on day one.',
    note: 'Blocked on the copy review going out Thursday.',
    effective_emoji: '📝',
    archived: false,
    ...over,
  } as unknown as CardWithType;
}

/** CardNode takes density as a controlled prop; drive it from local state. */
function ControlledCard({
  card,
  initialCompact = false,
}: {
  card: CardWithType;
  initialCompact?: boolean;
}) {
  const [compact, setCompact] = useState(initialCompact);
  return (
    <div data-testid={`wrap-${card.card_id}`}>
      <CardNode data={{ card, compact, onToggleCompact: (_id, next) => setCompact(next) }} />
    </div>
  );
}

function heightOf(testId: string): number {
  return screen.getByTestId(testId).getBoundingClientRect().height;
}

describe('CardNode density (real browser layout)', () => {
  it('collapsing actually shortens the card and expanding restores it', () => {
    render(<ControlledCard card={makeCard()} />);

    const expanded = heightOf('wrap-card-1');
    expect(expanded).toBeGreaterThan(80);
    expect(screen.getByText(/welcome step still reads/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Collapse card'));

    const collapsed = heightOf('wrap-card-1');
    expect(screen.queryByText(/welcome step still reads/)).toBeNull();
    expect(collapsed).toBeLessThan(expanded);
    // The compact_list layout budgets 56px for a card; the real collapsed
    // header must fit that, or arranged zones overlap.
    expect(collapsed).toBeLessThanOrEqual(60);

    fireEvent.click(screen.getByLabelText('Expand card'));
    expect(heightOf('wrap-card-1')).toBeCloseTo(expanded, 0);
    expect(screen.getByText(/welcome step still reads/)).toBeTruthy();
  });

  it('keeps the expand control a real, legible hit target while collapsed', () => {
    render(<ControlledCard card={makeCard()} initialCompact />);

    const button = screen.getByLabelText('Expand card');
    const box = button.getBoundingClientRect();
    // A control the user cannot see or hit is not an escape hatch.
    expect(box.width).toBeGreaterThanOrEqual(20);
    expect(box.height).toBeGreaterThanOrEqual(20);
    expect(getComputedStyle(button).visibility).toBe('visible');

    // The title must still be readable beside it, not crushed to nothing.
    const title = screen.getByText('Refine onboarding copy');
    expect(title.getBoundingClientRect().width).toBeGreaterThan(100);
  });

  it('does not render a control on a card with nothing to collapse', () => {
    render(
      <ControlledCard
        card={makeCard({ description: undefined, note: undefined } as Partial<CardWithType>)}
      />
    );

    expect(screen.queryByLabelText('Collapse card')).toBeNull();
    expect(screen.queryByLabelText('Expand card')).toBeNull();
  });

  it('stacks collapsed cards without overlapping', () => {
    const cards = [
      makeCard({ card_id: 'c1', title: 'Refine onboarding copy' }),
      makeCard({ card_id: 'c2', title: 'Audit spacing tokens' }),
      makeCard({ card_id: 'c3', title: 'Ship the changelog' }),
    ];
    render(
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {cards.map((card) => (
          <ControlledCard key={card.card_id} card={card} initialCompact />
        ))}
      </div>
    );

    const boxes = cards.map((card) =>
      screen.getByTestId(`wrap-${card.card_id}`).getBoundingClientRect()
    );
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom - 0.5);
    }
    // Every collapsed card keeps its own way back out.
    for (const card of cards) {
      expect(screen.getByTestId(`wrap-${card.card_id}`).textContent).toContain(card.title);
    }
    expect(screen.getAllByLabelText('Expand card')).toHaveLength(3);
  });
});
