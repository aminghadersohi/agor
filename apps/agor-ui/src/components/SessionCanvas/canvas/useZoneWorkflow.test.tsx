import type { AgorClient, BoardID, ZoneWorkflowTransition } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useZoneWorkflow } from './useZoneWorkflow';

describe('useZoneWorkflow', () => {
  it('loads a board snapshot and reconciles production Feathers transition events', async () => {
    const boardId = '00000000-0000-7000-8000-000000000010' as BoardID;
    const handlers = new Map<string, (row: ZoneWorkflowTransition) => void>();
    const initial = {
      transition_id: '00000000-0000-7000-8000-000000000020',
      board_id: boardId,
      source_zone_id: 'todo',
      target_zone_id: 'done',
      label: 'Complete',
      enabled: true,
      behavior: 'guidance_only',
    } as ZoneWorkflowTransition;
    const service = {
      find: vi.fn(async () => ({ data: [initial] })),
      create: vi.fn(),
      patch: vi.fn(),
      remove: vi.fn(),
      on: vi.fn((event: string, handler: (row: ZoneWorkflowTransition) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn(),
    };
    const client = {
      service: vi.fn(() => service),
      io: { on: vi.fn(), off: vi.fn() },
    } as unknown as AgorClient;

    const { result, unmount } = renderHook(() => useZoneWorkflow(client, boardId));
    await waitFor(() => expect(result.current.transitions).toEqual([initial]));
    expect(service.find).toHaveBeenCalledWith({ query: { board_id: boardId } });

    const patched = { ...initial, label: 'Shipped' };
    act(() => handlers.get('patched')?.(patched));
    expect(result.current.transitions).toEqual([patched]);
    act(() => handlers.get('removed')?.(patched));
    expect(result.current.transitions).toEqual([]);

    unmount();
    expect(service.off).toHaveBeenCalledTimes(3);
    expect(client.io.off).toHaveBeenCalledWith('connect', expect.any(Function));
  });
});
