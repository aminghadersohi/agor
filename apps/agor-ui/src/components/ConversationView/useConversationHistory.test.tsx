import type { SessionID, Task, TaskID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useConversationHistory } from './useConversationHistory';

const scrollRef = { current: null };
const sessionId = '01990000-0000-7000-8000-000000000001' as SessionID;

// Fictional, deterministic tasks only.
function fixtureTasks(count: number, offset = 0): Task[] {
  return Array.from({ length: count }, (_, n) => {
    const i = n + offset;
    const timestamp = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
    return {
      task_id: `01990001-0000-7000-8000-${String(i).padStart(12, '0')}` as TaskID,
      session_id: sessionId,
      created_by: '01990000-0000-7000-8000-000000000002',
      full_prompt: `Fictional task ${i}`,
      status: TaskStatus.COMPLETED,
      created_at: timestamp,
      message_range: { start_index: i * 2, end_index: i * 2 + 1, start_timestamp: timestamp },
      git_state: { ref_at_start: 'fixture', sha_at_start: '0'.repeat(40) },
    };
  });
}

describe('conversation render history', () => {
  it.each([20, 50])(
    'preserves the existing %i-task view bound through reveal and arrivals',
    (pageSize) => {
      const tasks = fixtureTasks(121);
      const { result, rerender } = renderHook(
        ({ rows }) => useConversationHistory(sessionId, rows, scrollRef, vi.fn(), pageSize),
        { initialProps: { rows: tasks.slice(0, 120) } }
      );
      expect(result.current.visibleTasks).toHaveLength(pageSize);
      act(() => result.current.revealOlder());
      const revealed = result.current.visibleTasks;
      expect(revealed).toHaveLength(pageSize * 2);
      rerender({ rows: tasks });
      expect(result.current.visibleTasks).toEqual([...revealed, tasks[120]]);
    }
  );

  it('honors canonical Session task order rather than assuming timestamps are monotonic', () => {
    const rows = [...fixtureTasks(65)].reverse();
    const { result, rerender } = renderHook(
      ({ rows }) => useConversationHistory(sessionId, rows, scrollRef, vi.fn()),
      { initialProps: { rows } }
    );
    const revealed = rows.slice(-30);
    expect(result.current.visibleTasks).toEqual(revealed);
    // The Session append/reorder can arrive after the Task event. Previously
    // shown tasks remain present even when their canonical positions change.
    const reordered = [rows.at(-1)!, ...rows.slice(0, -1)];
    rerender({ rows: reordered });
    expect(result.current.visibleTasks).toEqual(reordered);
    expect(revealed.every((task) => result.current.visibleTasks.includes(task))).toBe(true);
  });

  it.each([0, 1, 29, 30, 31, 60, 61, 95])(
    'reveals %i tasks without gaps or duplicates',
    (count) => {
      const tasks = fixtureTasks(count);
      const { result } = renderHook(() =>
        useConversationHistory(sessionId, tasks, scrollRef, vi.fn())
      );
      expect(result.current.visibleTasks).toEqual(tasks.slice(-30));
      while (result.current.olderCount) {
        const previous = result.current.visibleTasks;
        act(() => result.current.revealOlder());
        expect(result.current.visibleTasks.slice(-previous.length)).toEqual(previous);
      }
      expect(result.current.visibleTasks).toEqual(tasks);
      expect(new Set(result.current.visibleTasks.map((t) => t.task_id)).size).toBe(count);
    }
  );

  it('keeps a stable deterministic boundary through arrivals, removals and patches', () => {
    const tasks = fixtureTasks(65).map((task) => ({
      ...task,
      created_at: '2026-01-01T00:00:00.000Z',
    }));
    const { result, rerender } = renderHook(
      ({ rows }) => useConversationHistory(sessionId, rows, scrollRef, vi.fn()),
      { initialProps: { rows: tasks.slice(0, 64) } }
    );
    const firstId = result.current.visibleTasks[0].task_id;
    // New tail must not evict the task currently being read.
    rerender({ rows: tasks });
    expect(result.current.visibleTasks[0].task_id).toBe(firstId);
    expect(result.current.visibleTasks).toHaveLength(31);
    const remaining = tasks
      .filter((t) => t.task_id !== firstId)
      .map((t) => ({ ...t, full_prompt: `${t.full_prompt} patched` }));
    rerender({ rows: remaining });
    expect(result.current.visibleTasks).toEqual(remaining.slice(34));
    act(() => result.current.revealOlder());
    act(() => result.current.revealOlder());
    expect(result.current.visibleTasks).toEqual(remaining);
  });

  it('keeps late backfill hidden behind an existing boundary', () => {
    const tasks = fixtureTasks(65);
    const { result, rerender } = renderHook(
      ({ rows }) => useConversationHistory(sessionId, rows, scrollRef, vi.fn()),
      { initialProps: { rows: tasks.slice(1) } }
    );
    const first = result.current.visibleTasks[0];
    rerender({ rows: tasks });
    expect(result.current.visibleTasks[0]).toBe(first);
    expect(result.current.olderCount).toBe(35);
    act(() => result.current.revealAllAtTop());
    expect(result.current.visibleTasks).toEqual(tasks);
  });

  it('shows an explicitly fetched older page once nothing is hidden', () => {
    const tasks = fixtureTasks(40);
    const { result, rerender } = renderHook(
      ({ rows }) => useConversationHistory(sessionId, rows, scrollRef, vi.fn()),
      { initialProps: { rows: tasks.slice(-10) } }
    );
    expect(result.current.olderCount).toBe(0);
    // Lean paging prepends reached history; it must not land behind the bound.
    rerender({ rows: tasks.slice(-20) });
    rerender({ rows: tasks.slice(-30) });
    rerender({ rows: tasks });
    expect(result.current.visibleTasks).toEqual(tasks);
    expect(result.current.olderCount).toBe(0);
  });

  it('resets on session change and initializes after loading', () => {
    const tasks = fixtureTasks(65);
    const stop = vi.fn();
    const { result, rerender } = renderHook(
      ({ id, rows }) => useConversationHistory(id, rows, scrollRef, stop),
      { initialProps: { id: sessionId, rows: tasks.slice(0, 0) } }
    );
    rerender({ id: sessionId, rows: tasks });
    expect(result.current.visibleTasks).toHaveLength(30);
    expect(result.current.olderCount).toBe(35);
    act(() => result.current.revealOlder());
    expect(result.current.visibleTasks).toHaveLength(60);
    rerender({ id: 'other-session' as SessionID, rows: tasks });
    expect(result.current.visibleTasks).toHaveLength(30);
    act(() => result.current.revealAllAtTop());
    expect(result.current.visibleTasks).toEqual(tasks);
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
