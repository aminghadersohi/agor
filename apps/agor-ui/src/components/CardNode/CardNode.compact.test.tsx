import type { CardWithType } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CardNode, { type CardNodeData } from './CardNode';

function makeCard(overrides: Partial<CardWithType> = {}): CardWithType {
  return {
    card_id: 'card-1',
    title: 'Planning card',
    description: 'Generic cards do not own a secondary density state.',
    note: 'This content must remain visible.',
    archived: false,
    ...overrides,
  } as unknown as CardWithType;
}

describe('CardNode density capability', () => {
  it('always renders card content without density controls', () => {
    render(<CardNode data={{ card: makeCard() }} />);

    expect(screen.getByText(/do not own a secondary density state/)).toBeTruthy();
    expect(screen.getByText(/must remain visible/)).toBeTruthy();
    expect(screen.queryByLabelText('Collapse card')).toBeNull();
    expect(screen.queryByLabelText('Expand card')).toBeNull();
  });

  it('ignores stale compact fields from an older realtime payload', () => {
    const staleData = {
      card: makeCard(),
      compact: true,
      onToggleCompact: () => undefined,
    } as CardNodeData;

    render(<CardNode data={staleData} />);

    expect(screen.getByText(/do not own a secondary density state/)).toBeTruthy();
    expect(screen.getByText(/must remain visible/)).toBeTruthy();
    expect(screen.queryByLabelText('Collapse card')).toBeNull();
    expect(screen.queryByLabelText('Expand card')).toBeNull();
  });

  it('renders a content-free card without manufacturing an escape hatch', () => {
    render(
      <CardNode
        data={{
          card: makeCard({ description: undefined, note: undefined } as Partial<CardWithType>),
        }}
      />
    );

    expect(screen.getByText('Planning card')).toBeTruthy();
    expect(screen.queryByLabelText('Collapse card')).toBeNull();
    expect(screen.queryByLabelText('Expand card')).toBeNull();
  });
});
