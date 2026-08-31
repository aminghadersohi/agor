import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../../contexts/ConnectionContext';
import { ZoneNode } from './BoardObjectNodes';

const zoneConfigModalRenderSpy = vi.hoisted(() => vi.fn());

vi.mock('./ZoneConfigModal', () => ({
  ZoneConfigModal: (props: { zoneName: string }) => {
    zoneConfigModalRenderSpy(props);
    return <div data-testid="zone-config-modal">Configure Zone: {props.zoneName}</div>;
  },
}));

const CONNECTED = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};
const DISCONNECTED = { ...CONNECTED, connected: false };

function renderZone(
  onReorder: ReturnType<typeof vi.fn>,
  connection: typeof CONNECTED,
  extra?: {
    selected?: boolean;
    suppressToolbar?: boolean;
    positionableItemCount?: number;
    onArrangeContents?: ReturnType<typeof vi.fn>;
    onJustifyContents?: ReturnType<typeof vi.fn>;
  }
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ConnectionProvider value={connection}>
      <AntApp>
        <ReactFlowProvider>{children}</ReactFlowProvider>
      </AntApp>
    </ConnectionProvider>
  );
  return render(
    <ZoneNode
      selected={extra?.selected ?? true}
      data={{
        objectId: 'zone-1',
        label: 'My Zone',
        width: 400,
        height: 300,
        x: 0,
        y: 0,
        zIndex: 100,
        suppressToolbar: extra?.suppressToolbar,
        positionableItemCount: extra?.positionableItemCount,
        onReorder,
        onArrangeContents: extra?.onArrangeContents,
        onJustifyContents: extra?.onJustifyContents,
      }}
    />,
    { wrapper }
  );
}

describe('ZoneNode layer toolbar', () => {
  it('dispatches Center in zone once through the direct toolbar production callback', () => {
    const onJustifyContents = vi.fn();
    renderZone(vi.fn(), CONNECTED, { positionableItemCount: 2, onJustifyContents });

    const button = screen.getByRole('button', { name: 'Center in zone' });
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    fireEvent.click(button);

    expect(onJustifyContents).toHaveBeenCalledTimes(1);
    expect(onJustifyContents).toHaveBeenCalledWith('zone-1', 'middle');
  });

  it('dispatches vertical centering through an explicit accessible action', () => {
    const onJustifyContents = vi.fn();
    renderZone(vi.fn(), CONNECTED, { positionableItemCount: 2, onJustifyContents });

    const button = screen.getByRole('button', { name: 'Center contents vertically' });
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    fireEvent.click(button);

    expect(onJustifyContents).toHaveBeenCalledTimes(1);
    expect(onJustifyContents).toHaveBeenCalledWith('zone-1', 'vertical_middle');
  });

  it('allows a single card or worktree to be tidied while keeping empty zones disabled', () => {
    const onArrangeContents = vi.fn();
    renderZone(vi.fn(), CONNECTED, { positionableItemCount: 1, onArrangeContents });

    const tidy = screen.getByRole('button', { name: 'Tidy up contents' });
    expect(tidy).toBeEnabled();
    fireEvent.pointerUp(tidy);
    expect(onArrangeContents).toHaveBeenCalledWith('zone-1');

    renderZone(vi.fn(), CONNECTED, { positionableItemCount: 0 });
    expect(screen.getAllByRole('button', { name: 'Tidy up contents' }).at(-1)).toBeDisabled();
  });

  it('portals the bounded toolbar above every node stacking context and wraps upward', () => {
    renderZone(vi.fn(), CONNECTED);

    const toolbar = screen.getByRole('toolbar', { name: 'Zone actions' });
    expect(toolbar.parentElement).toBe(document.body);
    expect(toolbar).toHaveStyle({
      position: 'fixed',
      zIndex: '10000',
      transform: 'translate(-50%, -100%)',
      flexWrap: 'wrap',
      width: 'max-content',
      maxWidth: 'min(460px, calc(100vw - 32px))',
    });
  });

  it('exposes the layer buttons with accessible labels', () => {
    renderZone(vi.fn(), CONNECTED);
    expect(screen.getByLabelText('Send to back')).toBeTruthy();
    expect(screen.getByLabelText('Send backward')).toBeTruthy();
    expect(screen.getByLabelText('Bring forward')).toBeTruthy();
    expect(screen.getByLabelText('Bring to front')).toBeTruthy();
  });

  it('does not render single-zone actions when the shared selection toolbar replaces them', () => {
    renderZone(vi.fn(), CONNECTED, { suppressToolbar: true });
    expect(screen.getByLabelText('Zone actions')).toHaveStyle({ display: 'none' });
  });

  it('fires onReorder exactly once for a mouse gesture (pointerUp only, never click)', () => {
    const onReorder = vi.fn();
    renderZone(onReorder, CONNECTED);
    const btn = screen.getByLabelText('Bring to front');
    // A full mouse tap: pointerDown → pointerUp → click. The action runs on
    // pointerUp; the trailing click (detail 1) must NOT also fire it. Some touch
    // engines emit a detail-0 synthesized click on tap too — assert that path is
    // inert as well so touch can't double-step.
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    fireEvent.click(btn, { detail: 1 });
    fireEvent.click(btn, { detail: 0 });
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith('zone-1', 'front');
  });

  it('fires onReorder exactly once on keyboard activation (Enter / Space)', () => {
    const onReorder = vi.fn();
    renderZone(onReorder, CONNECTED);
    const btn = screen.getByLabelText('Bring forward');
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenLastCalledWith('zone-1', 'forward');

    fireEvent.keyDown(btn, { key: ' ' });
    expect(onReorder).toHaveBeenCalledTimes(2);
    expect(onReorder).toHaveBeenLastCalledWith('zone-1', 'forward');
  });

  it('does not compound keyboard + the click the browser synthesizes after it', () => {
    const onReorder = vi.fn();
    renderZone(onReorder, CONNECTED);
    const btn = screen.getByLabelText('Send to back');
    // Real browsers fire a detail-0 click after Enter on a button. onKeyDown
    // handles activation; onClick is inert — so the pair must total ONE call.
    fireEvent.keyDown(btn, { key: 'Enter' });
    fireEvent.click(btn, { detail: 0 });
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith('zone-1', 'back');
  });

  it('does NOT fire onReorder when the mutation gate is closed (disconnected)', () => {
    const onReorder = vi.fn();
    renderZone(onReorder, DISCONNECTED);
    const btn = screen.getByLabelText('Bring to front');
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    fireEvent.keyDown(btn, { key: 'Enter' });
    fireEvent.click(btn, { detail: 0 });
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe('ZoneNode config modal', () => {
  beforeEach(() => {
    zoneConfigModalRenderSpy.mockClear();
  });

  it('mounts the configuration modal only when the user opens it', () => {
    renderZone(vi.fn(), CONNECTED);

    expect(zoneConfigModalRenderSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('zone-config-modal')).not.toBeInTheDocument();

    fireEvent.pointerUp(screen.getByTitle('Configure zone'));

    expect(zoneConfigModalRenderSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('zone-config-modal')).toHaveTextContent('Configure Zone: My Zone');
  });
});

function renderZoneDensity(opts: {
  pinnedItemCount: number;
  compactItemCount: number;
  onSetContentsCompact?: ReturnType<typeof vi.fn>;
  connection?: typeof CONNECTED;
}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ConnectionProvider value={opts.connection ?? CONNECTED}>
      <AntApp>
        <ReactFlowProvider>{children}</ReactFlowProvider>
      </AntApp>
    </ConnectionProvider>
  );
  return render(
    <ZoneNode
      selected={true}
      data={{
        objectId: 'zone-1',
        label: 'Review',
        width: 400,
        height: 300,
        x: 0,
        y: 0,
        zIndex: 100,
        pinnedItemCount: opts.pinnedItemCount,
        compactItemCount: opts.compactItemCount,
        onSetContentsCompact: opts.onSetContentsCompact,
      }}
    />,
    { wrapper }
  );
}

describe('ZoneNode density toolbar', () => {
  it('offers "Collapse contents" while any pinned item is still expanded', () => {
    const onSetContentsCompact = vi.fn();
    renderZoneDensity({ pinnedItemCount: 3, compactItemCount: 0, onSetContentsCompact });

    const btn = screen.getByLabelText('Collapse contents');
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);

    expect(onSetContentsCompact).toHaveBeenCalledTimes(1);
    expect(onSetContentsCompact).toHaveBeenCalledWith('zone-1', true);
  });

  it('flips to "Expand contents" only once every pinned item is collapsed', () => {
    const onSetContentsCompact = vi.fn();
    renderZoneDensity({ pinnedItemCount: 3, compactItemCount: 3, onSetContentsCompact });

    const btn = screen.getByLabelText('Expand contents');
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);

    expect(onSetContentsCompact).toHaveBeenCalledWith('zone-1', false);
  });

  it('still collapses a partially collapsed zone, making it uniform in one click', () => {
    const onSetContentsCompact = vi.fn();
    renderZoneDensity({ pinnedItemCount: 3, compactItemCount: 2, onSetContentsCompact });

    expect(screen.queryByLabelText('Expand contents')).toBeNull();
    fireEvent.pointerUp(screen.getByLabelText('Collapse contents'));

    expect(onSetContentsCompact).toHaveBeenCalledWith('zone-1', true);
  });

  it('disables the control on an empty zone', () => {
    const onSetContentsCompact = vi.fn();
    renderZoneDensity({ pinnedItemCount: 0, compactItemCount: 0, onSetContentsCompact });

    const btn = screen.getByLabelText('Collapse contents');
    expect(btn).toBeDisabled();
    fireEvent.pointerUp(btn);
    expect(onSetContentsCompact).not.toHaveBeenCalled();
  });

  it('does not fire when the mutation gate is closed (disconnected)', () => {
    const onSetContentsCompact = vi.fn();
    renderZoneDensity({
      pinnedItemCount: 2,
      compactItemCount: 0,
      onSetContentsCompact,
      connection: DISCONNECTED,
    });

    const btn = screen.getByLabelText('Collapse contents');
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
    fireEvent.keyDown(btn, { key: 'Enter' });

    expect(onSetContentsCompact).not.toHaveBeenCalled();
  });
});
