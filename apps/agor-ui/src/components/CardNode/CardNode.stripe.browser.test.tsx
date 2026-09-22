// biome-ignore-all lint/plugin/noHardcodedColorLiteral: color fixtures verify the user-selectable entity palette
import type { CardWithType } from '@agor-live/client';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CardNode from './CardNode';

/**
 * Real-browser test: jsdom's CSS engine drops the `border` / `border-left`
 * shorthands entirely, so the stale-edge bug this guards against is invisible
 * there. It only shows up in a real CSSOM on a *re-render* — React applies only
 * the style keys whose value changed, so a shorthand that still covers the left
 * edge silently repaints over an unchanged stripe.
 *
 * Assertions read `element.style` (the specified value) rather than
 * `getComputedStyle`, because the card animates `border-color` over 0.3s and
 * the computed value mid-transition is still the previous color.
 */

const RED = 'rgb(255, 86, 48)';
const ZONE_BLUE = 'rgb(22, 119, 255)';

const card = (overrides: Partial<CardWithType> = {}) =>
  ({
    card_id: 'card-1',
    title: 'Planning card',
    archived: false,
    ...overrides,
  }) as unknown as CardWithType;

const root = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe('CardNode accent stripe', () => {
  it("keeps the user's stripe when the card is pinned into a zone mid-render", async () => {
    const colored = card({ color_override: '#ff5630', effective_color: '#ff5630' });
    const { container, rerender } = render(<CardNode data={{ card: colored }} />);
    expect(root(container).style.borderLeftColor).toBe(RED);

    // Dragging a card into a zone re-renders with a new zone color while the
    // stripe value is unchanged. Before the longhand fix this repainted the
    // left edge with the zone color and lost the user's grouping signal.
    rerender(<CardNode data={{ card: colored, isPinned: true, zoneColor: '#1677ff' }} />);
    const pinned = root(container).style;
    expect(pinned.borderLeftColor).toBe(RED);
    expect(pinned.borderLeftWidth).toBe('4px');
    // Zone membership still reads on the other three edges.
    expect(pinned.borderTopColor).toBe(ZONE_BLUE);
    expect(pinned.borderTopWidth).toBe('1px');

    // And it survives the border-color transition rather than only being
    // specified — this is what the operator actually sees on the canvas.
    await waitFor(() => expect(getComputedStyle(root(container)).borderLeftColor).toBe(RED));
    expect(getComputedStyle(root(container)).borderTopColor).toBe(ZONE_BLUE);
  });

  it('falls back to the zone color on every edge when the user set none', () => {
    const { container, rerender } = render(<CardNode data={{ card: card() }} />);
    rerender(<CardNode data={{ card: card(), isPinned: true, zoneColor: '#1677ff' }} />);
    expect(root(container).style.borderLeftColor).toBe(ZONE_BLUE);
    expect(root(container).style.borderLeftWidth).toBe('4px');
  });

  it('restores the neutral edge when the card is dragged back out of the zone', () => {
    const colored = card({ color_override: '#ff5630', effective_color: '#ff5630' });
    const { container, rerender } = render(
      <CardNode data={{ card: colored, isPinned: true, zoneColor: '#1677ff' }} />
    );
    rerender(<CardNode data={{ card: colored }} />);
    const unpinned = root(container).style;
    expect(unpinned.borderLeftColor).toBe(RED);
    expect(unpinned.borderTopColor).not.toBe(ZONE_BLUE);
  });
});
