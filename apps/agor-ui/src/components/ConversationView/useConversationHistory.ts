import type { SessionID, Task } from '@agor/core/types';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

export const CONVERSATION_TASK_PAGE_SIZE = 30;

/**
 * A render boundary, not a data cursor: the reactive session still owns every
 * task it has fetched. `hiddenTaskIds` are older tasks deliberately left
 * unmounted; `shownTaskIds` are tasks already mounted for the reader.
 */
interface Boundary {
  sessionId: SessionID | null;
  hiddenTaskIds: ReadonlySet<string>;
  shownTaskIds: ReadonlySet<string>;
}

function boundaryFor(sessionId: SessionID | null, tasks: Task[], startIndex: number): Boundary {
  return {
    sessionId,
    hiddenTaskIds: new Set(tasks.slice(0, startIndex).map((task) => task.task_id)),
    shownTaskIds: new Set(tasks.slice(startIndex).map((task) => task.task_id)),
  };
}

function sameIds(ids: ReadonlySet<string>, tasks: Task[]): boolean {
  return ids.size === tasks.length && tasks.every((task) => ids.has(task.task_id));
}

/**
 * Bound how many already-fetched tasks a conversation mounts at once.
 *
 * A reopened conversation whose reactive session already holds a long history
 * mounts only its newest page of task blocks; older ones stay one click away
 * ("Show older tasks"). Tasks that arrive later — realtime turns at the tail,
 * or an explicitly fetched page of older history while nothing is hidden —
 * are shown, and a task already shown is never unmounted underneath the
 * reader.
 */
export function useConversationHistory(
  sessionId: SessionID | null,
  tasks: Task[],
  scrollRef: { current: HTMLElement | null },
  stopScroll: () => void,
  pageSize = CONVERSATION_TASK_PAGE_SIZE
) {
  const [boundary, setBoundary] = useState<Boundary | null>(() =>
    tasks.length ? boundaryFor(sessionId, tasks, Math.max(0, tasks.length - pageSize)) : null
  );
  const anchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  const jumpToTop = useRef(false);

  const startIndex = useMemo(() => {
    if (!boundary || boundary.sessionId !== sessionId) {
      return Math.max(0, tasks.length - pageSize);
    }
    if (!boundary.hiddenTaskIds.size) return 0;
    // Preserve the client's canonical Session.tasks order (which can differ
    // from timestamps). Everything up to the last hidden task stays hidden,
    // except that a task the reader has already seen is never evicted by an
    // ordering patch or a late backfill.
    let afterHidden = 0;
    let firstShown = -1;
    tasks.forEach((task, index) => {
      if (boundary.hiddenTaskIds.has(task.task_id)) afterHidden = index + 1;
      else if (firstShown === -1 && boundary.shownTaskIds.has(task.task_id)) firstShown = index;
    });
    return firstShown === -1 ? afterHidden : Math.min(firstShown, afterHidden);
  }, [boundary, sessionId, tasks, pageSize]);

  const visibleTasks = useMemo(
    () => (startIndex ? tasks.slice(startIndex) : tasks),
    [startIndex, tasks]
  );

  useLayoutEffect(() => {
    if (
      tasks.length &&
      (boundary?.sessionId !== sessionId ||
        !sameIds(boundary.shownTaskIds, visibleTasks) ||
        !sameIds(boundary.hiddenTaskIds, tasks.slice(0, startIndex)))
    ) {
      setBoundary(boundaryFor(sessionId, tasks, startIndex));
    } else if (!tasks.length && boundary) {
      setBoundary(null);
    }
    // Restore geometry before paint. Measuring the same DOM element also
    // handles native scroll anchoring (a browser that already compensated
    // produces a zero delta), instead of double-applying scrollHeight changes.
    const pending = anchor.current;
    anchor.current = null;
    const scroller = scrollRef.current;
    if (scroller && pending && scroller.contains(pending.element)) {
      scroller.scrollTop += pending.element.getBoundingClientRect().top - pending.top;
    }
    if (scroller && jumpToTop.current) scroller.scrollTop = 0;
    jumpToTop.current = false;
  });

  const revealOlder = useCallback(() => {
    if (!startIndex) return;
    stopScroll();
    const element = scrollRef.current?.querySelector<HTMLElement>('[data-task-block]');
    anchor.current = element ? { element, top: element.getBoundingClientRect().top } : null;
    setBoundary(boundaryFor(sessionId, tasks, Math.max(0, startIndex - pageSize)));
  }, [scrollRef, sessionId, startIndex, stopScroll, tasks, pageSize]);

  const revealAllAtTop = useCallback(() => {
    // While content is still streaming/growing, the library's persistent
    // observer can re-pin to the bottom before our scrollTop write takes
    // effect. `stopScroll()` synchronously releases the bottom lock so the
    // jump to the top sticks.
    stopScroll();
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (!tasks.length) return;
    jumpToTop.current = true;
    setBoundary(boundaryFor(sessionId, tasks, 0));
  }, [scrollRef, sessionId, stopScroll, tasks]);

  return {
    visibleTasks,
    olderCount: startIndex,
    revealOlder,
    revealAllAtTop,
  };
}
