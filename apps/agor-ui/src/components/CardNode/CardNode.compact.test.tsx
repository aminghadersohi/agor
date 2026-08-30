import type { CardWithType } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CardNode from './CardNode';

function makeCard(overrides: Partial<CardWithType> = {}): CardWithType {
  return {
    card_id: 'card-1',
    title: 'Planning card',
    description: 'Some secondary content that collapsing actually hides.',
    archived: false,
    ...overrides,
  } as unknown as CardWithType;
}

describe('CardNode compact toggle', () => {
  it('offers a collapse control on an expanded card with secondary content', () => {
    render(<CardNode data={{ card: makeCard(), onToggleCompact: vi.fn() }} />);

    expect(screen.getByLabelText('Collapse card')).toBeTruthy();
    expect(screen.queryByLabelText('Expand card')).toBeNull();
  });

  it('asks for compact=true when collapsing and compact=false when expanding', () => {
    const onToggleCompact = vi.fn();
    const { rerender } = render(<CardNode data={{ card: makeCard(), onToggleCompact }} />);

    fireEvent.click(screen.getByLabelText('Collapse card'));
    expect(onToggleCompact).toHaveBeenCalledWith('card-1', true);

    rerender(<CardNode data={{ card: makeCard(), compact: true, onToggleCompact }} />);

    fireEvent.click(screen.getByLabelText('Expand card'));
    expect(onToggleCompact).toHaveBeenLastCalledWith('card-1', false);
    expect(onToggleCompact).toHaveBeenCalledTimes(2);
  });

  it('keeps the expand control on a collapsed card — it is the only way back out', () => {
    // The collapsed body is hidden, so a card with no description and no note
    // still has to surface its escape hatch after MCP or a compact_list zone
    // layout collapses it.
    render(
      <CardNode
        data={{
          card: makeCard({ description: undefined, note: undefined } as Partial<CardWithType>),
          compact: true,
          onToggleCompact: vi.fn(),
        }}
      />
    );

    expect(screen.getByLabelText('Expand card')).toBeTruthy();
  });

  it('hides the toggle on an expanded card that has nothing to collapse', () => {
    render(
      <CardNode
        data={{
          card: makeCard({ description: undefined, note: undefined } as Partial<CardWithType>),
          onToggleCompact: vi.fn(),
        }}
      />
    );

    expect(screen.queryByLabelText('Collapse card')).toBeNull();
    expect(screen.queryByLabelText('Expand card')).toBeNull();
  });

  it('renders no toggle when the viewer cannot mutate the board', () => {
    // SessionCanvas omits onToggleCompact unless the caller holds board.edit,
    // so a viewer never sees a control whose patch is certain to 403.
    render(<CardNode data={{ card: makeCard(), compact: true }} />);

    expect(screen.queryByLabelText('Expand card')).toBeNull();
    expect(screen.queryByLabelText('Collapse card')).toBeNull();
  });

  it('does not open the card while toggling density', () => {
    const onClick = vi.fn();
    const onToggleCompact = vi.fn();
    render(<CardNode data={{ card: makeCard(), onClick, onToggleCompact }} />);

    fireEvent.click(screen.getByLabelText('Collapse card'));

    expect(onToggleCompact).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps the exposed stack header and its action button interactive', () => {
    const onToggleCompact = vi.fn();
    const onAutoZoneInteraction = vi.fn();
    const { container } = render(
      <CardNode
        data={{
          card: makeCard(),
          compact: true,
          onToggleCompact,
          onAutoZoneInteraction,
        }}
      />
    );

    const header = container.querySelector('[data-zone-stack-header]');
    const expand = screen.getByLabelText('Expand card');
    expect(header).toContainElement(expand);
    expect(expand).not.toBeDisabled();
    fireEvent.pointerDown(expand);
    fireEvent.click(expand);
    expect(onAutoZoneInteraction).toHaveBeenCalledWith('card-1');
    expect(onToggleCompact).toHaveBeenCalledWith('card-1', false);
  });
});
