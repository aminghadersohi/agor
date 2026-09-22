// biome-ignore-all lint/plugin/noHardcodedColorLiteral: color fixtures verify user-selectable canvas styling
import type { CardWithType } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CardNode from './CardNode';

const card = (overrides: Partial<CardWithType> = {}) =>
  ({
    card_id: 'card-1',
    title: 'Planning card',
    archived: false,
    ...overrides,
  }) as unknown as CardWithType;

describe('CardNode color', () => {
  it('offers the picker only to callers who can edit the board', () => {
    const onSetColor = vi.fn();
    const { rerender } = render(<CardNode data={{ card: card(), onSetColor, canEdit: false }} />);
    expect(screen.queryByLabelText('Card color')).toBeNull();

    rerender(<CardNode data={{ card: card(), onSetColor, canEdit: true }} />);
    expect(screen.getByLabelText('Card color')).not.toBeNull();
  });

  it('persists a picked swatch and clears with No color', async () => {
    const onSetColor = vi.fn();
    render(
      <CardNode data={{ card: card({ color_override: '#ff5630' }), onSetColor, canEdit: true }} />
    );

    fireEvent.click(screen.getByLabelText('Card color'));
    fireEvent.click(await screen.findByRole('button', { name: 'Green' }));
    expect(onSetColor).toHaveBeenCalledWith('card-1', expect.stringMatching(/^#[0-9a-f]{6}$/i));

    fireEvent.click(screen.getByLabelText('Card color'));
    fireEvent.click(await screen.findByRole('button', { name: 'No color' }));
    expect(onSetColor).toHaveBeenLastCalledWith('card-1', null);
  });
});
