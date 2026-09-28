import type {
  AgorClient,
  BoardID,
  ZoneWorkflowAdvance,
  ZoneWorkflowTransition,
} from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ADVANCE_HISTORY_PAGE_SIZE,
  ZoneWorkflowAdvanceHistoryModal,
} from './ZoneWorkflowAdvanceHistoryModal';

const boardId = '00000000-0000-7000-8000-000000000010' as BoardID;
const transition = {
  transition_id: '00000000-0000-7000-8000-000000000020',
  board_id: boardId,
  source_zone_id: 'todo',
  target_zone_id: 'done',
  label: 'Ship',
  enabled: true,
  behavior: 'target_zone_prompt',
} as ZoneWorkflowTransition;

function advance(id: string, overrides: Partial<ZoneWorkflowAdvance> = {}): ZoneWorkflowAdvance {
  return {
    advance_id: id,
    transition_id: transition.transition_id,
    board_id: boardId,
    idempotency_key: `key-${id}`,
    source_zone_id: 'todo',
    target_zone_id: 'done',
    transition_label: 'Ship',
    behavior: 'target_zone_prompt',
    entities: [{ entity_type: 'branch', entity_id: `branch-${id}`, board_object_id: 'o' }],
    requested_by: 'user-1',
    requested_at: new Date().toISOString(),
    prompt_outcome: 'triggered',
    ...overrides,
  } as ZoneWorkflowAdvance;
}

function setup(pages: Array<{ total: number; data: ZoneWorkflowAdvance[] }>) {
  const handlers = new Map<string, (row: ZoneWorkflowAdvance) => void>();
  const service = {
    find: vi.fn(async () => pages.shift() ?? { total: 0, data: [] }),
    on: vi.fn((event: string, handler: (row: ZoneWorkflowAdvance) => void) => {
      handlers.set(event, handler);
    }),
    off: vi.fn(),
  };
  const client = { service: vi.fn(() => service) } as unknown as AgorClient;
  const view = render(
    <ZoneWorkflowAdvanceHistoryModal
      open
      client={client}
      boardId={boardId}
      transition={transition}
      describeEntity={(entity) => `name:${entity.entity_id}`}
      describeUser={(userId) => `user:${userId}`}
      onClose={vi.fn()}
    />
  );
  return { service, handlers, client, ...view };
}

describe('ZoneWorkflowAdvanceHistoryModal', () => {
  it('shows who advanced what with a spelled-out prompt outcome, and pages', async () => {
    const { service } = setup([
      {
        total: 3,
        data: [
          advance('a'),
          advance('b', { prompt_outcome: 'failed', prompt_error: 'executor unavailable' }),
        ],
      },
      { total: 3, data: [advance('c', { prompt_outcome: 'target_requires_picker' })] },
    ]);

    expect(await screen.findByText('name:branch-a')).toBeTruthy();
    expect(screen.getByText('Prompt started')).toBeTruthy();
    expect(screen.getByText('Prompt failed')).toBeTruthy();
    expect(screen.getByText('executor unavailable')).toBeTruthy();
    expect(screen.getAllByText(/user:user-1/)).toHaveLength(2);
    expect(service.find).toHaveBeenCalledWith({
      query: {
        board_id: boardId,
        transition_id: transition.transition_id,
        $limit: ADVANCE_HISTORY_PAGE_SIZE,
        $skip: 0,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /Load more \(1\)/ }));
    expect(await screen.findByText('Needs manual session choice')).toBeTruthy();
    expect(service.find).toHaveBeenLastCalledWith({
      query: expect.objectContaining({ $skip: 2 }),
    });
    expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull();
  });

  it('prepends live advances for this transition only and unsubscribes on unmount', async () => {
    const { handlers, service, unmount } = setup([{ total: 0, data: [] }]);
    expect(
      await screen.findByText('Nothing has been advanced along this transition yet.')
    ).toBeTruthy();

    act(() => handlers.get('created')?.(advance('other', { transition_id: 'another-edge' })));
    act(() => handlers.get('created')?.(advance('live')));
    await waitFor(() => expect(screen.getByText('name:branch-live')).toBeTruthy());
    act(() => handlers.get('created')?.(advance('live')));
    expect(screen.getAllByText('name:branch-live')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull();
    expect(screen.queryByText('name:branch-other')).toBeNull();

    unmount();
    expect(service.off).toHaveBeenCalledWith('created', expect.any(Function));
  });
});
