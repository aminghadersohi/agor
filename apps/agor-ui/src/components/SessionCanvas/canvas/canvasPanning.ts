import { type RefObject, useEffect, useState } from 'react';
import type { Viewport } from 'reactflow';

/** Mouse buttons React Flow pans with: 1 is the middle button, 2 the right. */
type PanButtons = number[];

/**
 * How dragging pans the canvas. In select mode a plain drag draws a marquee,
 * so the middle button pans instead (React Flow lets it pan over nodes too).
 * Workflow mode keeps the left button for connections.
 */
export function canvasPanOnDrag(activeTool: string, drawingZone: boolean): boolean | PanButtons {
  if (drawingZone) return false;
  if (activeTool === 'workflow') return [1, 2];
  if (activeTool === 'select') return [1];
  return true;
}

/** Whether Space belongs to the focused element: typing in a field, or pressing a button. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) ||
    target.closest('[contenteditable="true"], .nokey') !== null
  );
}

/** True while Space is held outside a text field; released on blur too. */
export function useSpacePan(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || isTypingTarget(event.target)) return;
      setHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setHeld(false);
    };
    const release = () => setHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', release);
    };
  }, []);
  return held;
}

export interface ViewportHandle {
  getViewport(): Viewport;
  setViewport(viewport: Viewport): void;
}

/**
 * While `active` (Space held), a left drag anywhere over the canvas pans it,
 * Figma-style: over zones and cards too, which would otherwise start a node
 * drag or a marquee. Capturing the pointer before React Flow sees it keeps
 * those gestures from starting at all.
 */
export function useSpaceDragPan(
  containerRef: RefObject<HTMLElement | null>,
  getViewportHandle: () => ViewportHandle | null | undefined,
  active: boolean
) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;
    let drag: { pointerId: number; x: number; y: number; viewport: Viewport } | null = null;
    const down = (event: PointerEvent) => {
      const handle = getViewportHandle();
      if (event.button !== 0 || !handle) return;
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        viewport: handle.getViewport(),
      };
      container.setPointerCapture?.(event.pointerId);
      // No node drag, marquee, or click starts underneath the hand.
      event.preventDefault();
      event.stopPropagation();
    };
    const move = (event: PointerEvent) => {
      if (drag?.pointerId !== event.pointerId) return;
      const { viewport } = drag;
      getViewportHandle()?.setViewport({
        x: viewport.x + event.clientX - drag.x,
        y: viewport.y + event.clientY - drag.y,
        zoom: viewport.zoom,
      });
      event.preventDefault();
      event.stopPropagation();
    };
    const end = (event: PointerEvent) => {
      if (drag?.pointerId !== event.pointerId) return;
      drag = null;
      container.releasePointerCapture?.(event.pointerId);
      event.stopPropagation();
    };
    container.addEventListener('pointerdown', down, true);
    container.addEventListener('pointermove', move, true);
    container.addEventListener('pointerup', end, true);
    container.addEventListener('pointercancel', end, true);
    return () => {
      container.removeEventListener('pointerdown', down, true);
      container.removeEventListener('pointermove', move, true);
      container.removeEventListener('pointerup', end, true);
      container.removeEventListener('pointercancel', end, true);
    };
  }, [containerRef, getViewportHandle, active]);
}
