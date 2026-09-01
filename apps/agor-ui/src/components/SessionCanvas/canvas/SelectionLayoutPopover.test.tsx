import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import {
  CANVAS_LAYOUT_CONTROLS_CLASS,
  SelectionLayoutPopover,
  selectionBoardZoneArrangementOptions,
  selectionGridTracks,
} from './SelectionLayoutPopover';

describe('selectionGridTracks', () => {
  it('derives the opposite track count without creating empty required tracks', () => {
    expect(selectionGridTracks(7, 'columns', 3)).toEqual({ columns: 3, rows: 3 });
    expect(selectionGridTracks(7, 'rows', 2)).toEqual({ columns: 4, rows: 2 });
    expect(selectionGridTracks(2, 'columns', 20)).toEqual({ columns: 2, rows: 1 });
  });
});

describe('selectionBoardZoneArrangementOptions', () => {
  it('maps columns, rows, and final-row distribution into the shared zone planner', () => {
    expect(
      selectionBoardZoneArrangementOptions(7, {
        mode: 'grid',
        trackAxis: 'columns',
        trackCount: 2,
        matchRowHeights: false,
        rowDistribution: 'packed',
      })
    ).toEqual({
      fixedItemsPerRow: 2,
      justifyLastRow: false,
      matchRowHeights: false,
    });
    expect(
      selectionBoardZoneArrangementOptions(7, {
        mode: 'grid',
        trackAxis: 'rows',
        trackCount: 2,
        matchRowHeights: true,
        rowDistribution: 'justify',
      })
    ).toEqual({
      fixedItemsPerRow: 4,
      justifyLastRow: true,
      matchRowHeights: true,
    });
  });

  it('uses the exact ordinary Arrange options for compact or toolbar arrange', () => {
    expect(selectionBoardZoneArrangementOptions(3)).toEqual({});
    expect(
      selectionBoardZoneArrangementOptions(3, {
        mode: 'compact',
        trackAxis: 'columns',
        trackCount: 2,
        matchRowHeights: false,
        rowDistribution: 'packed',
      })
    ).toEqual({});
  });
});

describe('SelectionLayoutPopover', () => {
  it('keeps compact as the ordinary default and exposes explicit grid controls', async () => {
    const onApply = vi.fn();
    render(
      <AntApp>
        <SelectionLayoutPopover selectionCount={7} onApply={onApply} />
      </AntApp>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    expect(await screen.findByText(/smallest stable, collision-free cluster/i)).toBeInTheDocument();
    const gridControl = screen.getByText('Grid');
    expect(gridControl.closest(`.${CANVAS_LAYOUT_CONTROLS_CLASS}`)).not.toBeNull();
    fireEvent.click(gridControl);
    expect(screen.getByLabelText('Fixed grid axis')).toBeInTheDocument();
    expect(screen.getByText('3 columns × 3 rows')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Match heights within rows'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply layout', hidden: true }));

    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({
        mode: 'grid',
        trackAxis: 'columns',
        trackCount: 3,
        matchRowHeights: true,
        rowDistribution: 'packed',
      })
    );
  });

  it('tracks the compact three-column default as a selection grows without overriding edits', async () => {
    const onApply = vi.fn();
    const view = render(
      <AntApp>
        <SelectionLayoutPopover selectionCount={2} onApply={onApply} />
      </AntApp>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Layout options' }));
    fireEvent.click(screen.getByText('Grid'));
    expect(screen.getByText('2 columns × 1 row')).toBeInTheDocument();

    view.rerender(
      <AntApp>
        <SelectionLayoutPopover selectionCount={9} onApply={onApply} />
      </AntApp>
    );
    expect(await screen.findByText('3 columns × 3 rows')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Number of columns'), { target: { value: '4' } });
    view.rerender(
      <AntApp>
        <SelectionLayoutPopover selectionCount={10} onApply={onApply} />
      </AntApp>
    );
    expect(await screen.findByText('4 columns × 3 rows')).toBeInTheDocument();
  });
});
