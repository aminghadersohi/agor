import type { BoardObject } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ZoneConfigModal } from './ZoneConfigModal';

vi.mock('../../../contexts/ConnectionContext', () => ({
  useMutationGate: () => ({ canMutate: true }),
}));

vi.mock('../../AgentSelectionGrid', () => ({
  AVAILABLE_AGENTS: [
    { id: 'claude-code', name: 'Claude Code' },
    { id: 'codex', name: 'Codex' },
  ],
  AgentSelectionGrid: ({
    agents,
    onSelect,
  }: {
    agents: Array<{ id: string; name: string }>;
    onSelect: (id: string) => void;
  }) => (
    <div>
      {agents.map((agent) => (
        <button key={agent.id} type="button" onClick={() => onSelect(agent.id)}>
          {agent.name}
        </button>
      ))}
    </div>
  ),
}));

function historicalZone(): BoardObject {
  return {
    type: 'zone',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    label: 'Review',
    trigger: {
      behavior: 'always_new',
      template: 'Review this branch',
      agent: 'claude-code-cli',
    },
  } as BoardObject;
}

describe('ZoneConfigModal historical tool migration', () => {
  it('selects and persists the List presentation', async () => {
    const onUpdate = vi.fn();
    render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={vi.fn()}
          zoneName="Review"
          objectId="zone-1"
          onUpdate={onUpdate}
          zoneData={{
            type: 'zone',
            x: 0,
            y: 0,
            width: 620,
            height: 900,
            label: 'Review',
            layout: { mode: 'manual', preset: 'grid' },
          }}
        />
      </AntdApp>
    );

    const list = await screen.findByText('List', { selector: '.ant-segmented-item-label' });
    fireEvent.click(list);
    expect(list.closest('.ant-segmented-item')).toHaveClass('ant-segmented-item-selected');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      layout: { preset: 'compact_list', columns: 1 },
    });
  });

  it('shows a persisted manual demotion by turning the Auto Zone control off', async () => {
    render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={vi.fn()}
          zoneName="Review"
          objectId="zone-1"
          onUpdate={vi.fn()}
          zoneData={{
            type: 'zone',
            x: 0,
            y: 0,
            width: 620,
            height: 900,
            label: 'Review',
            layout: { mode: 'manual', preset: 'grid' },
          }}
        />
      </AntdApp>
    );

    expect(await screen.findByRole('switch', { name: 'Auto Zone' })).not.toBeChecked();
  });

  it('preserves the removed tool until the operator explicitly selects a supported one', async () => {
    const onUpdate = vi.fn();
    render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={vi.fn()}
          zoneName="Review"
          objectId="zone-1"
          onUpdate={onUpdate}
          zoneData={historicalZone()}
        />
      </AntdApp>
    );

    expect(await screen.findByText('This zone uses a removed agentic tool')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(onUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      trigger: {
        behavior: 'always_new',
        template: 'Review this branch',
        agent: 'codex',
      },
    });
  });

  it('uses latest-first as the opinionated default when automatic layout is enabled', async () => {
    const onUpdate = vi.fn();
    render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={vi.fn()}
          zoneName="Review"
          objectId="zone-1"
          onUpdate={onUpdate}
          zoneData={{
            type: 'zone',
            x: 0,
            y: 0,
            width: 620,
            height: 900,
            label: 'Review',
          }}
        />
      </AntdApp>
    );

    fireEvent.click(await screen.findByRole('switch', { name: 'Auto Zone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      layout: {
        mode: 'auto',
        preset: 'grid',
        sortBy: 'updated',
        sortDirection: 'desc',
        autoResizeHeight: false,
        gap: 24,
      },
    });
  });

  it('pairs Grow to fit with minimal collision reflow while preserving the public policy field', async () => {
    const onUpdate = vi.fn();
    render(
      <AntdApp>
        <ZoneConfigModal
          open
          onCancel={vi.fn()}
          zoneName="Review"
          objectId="zone-1"
          onUpdate={onUpdate}
          zoneData={{
            type: 'zone',
            x: 0,
            y: 0,
            width: 620,
            height: 300,
            label: 'Review',
          }}
        />
      </AntdApp>
    );

    fireEvent.click(await screen.findByRole('switch', { name: 'Grow to fit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      layout: {
        autoResizeHeight: true,
        resize: 'height',
        onOverflow: 'reflow_board',
      },
    });
  });
});
