import { act, fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { canvasPanOnDrag, useSpaceDragPan, useSpacePan } from './canvasPanning';

describe('canvasPanOnDrag', () => {
  it('pans with the middle button in select mode, where a plain drag draws a marquee', () => {
    expect(canvasPanOnDrag('select', false)).toEqual([1]);
  });

  it('keeps workflow connections on the left button and placement tools pannable', () => {
    expect(canvasPanOnDrag('workflow', false)).toEqual([1, 2]);
    expect(canvasPanOnDrag('comment', false)).toBe(true);
  });

  it('never pans while a zone is being drawn', () => {
    expect(canvasPanOnDrag('zone', true)).toBe(false);
  });
});

describe('useSpacePan', () => {
  const key = (type: 'keydown' | 'keyup', target: EventTarget = window) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent(type, { code: 'Space', bubbles: true }));
    });

  it('holds while Space is down and lets go on keyup or when the window loses focus', () => {
    const { result } = renderHook(() => useSpacePan());
    expect(result.current).toBe(false);
    key('keydown');
    expect(result.current).toBe(true);
    key('keyup');
    expect(result.current).toBe(false);
    key('keydown');
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(result.current).toBe(false);
  });

  it('leaves Space to text fields and buttons', () => {
    const { result } = renderHook(() => useSpacePan());
    for (const tag of ['textarea', 'input', 'button']) {
      const element = document.createElement(tag);
      document.body.append(element);
      key('keydown', element);
      expect(result.current).toBe(false);
      element.remove();
    }
  });
});

describe('useSpaceDragPan', () => {
  function setup(active: boolean) {
    const container = document.createElement('div');
    const card = document.createElement('div');
    container.append(card);
    document.body.append(container);
    let viewport = { x: 100, y: 50, zoom: 0.5 };
    const handle = {
      getViewport: () => viewport,
      setViewport: vi.fn((next: typeof viewport) => {
        viewport = next;
      }),
    };
    const cardPointerDown = vi.fn();
    card.addEventListener('pointerdown', cardPointerDown);
    const hook = renderHook(({ on }) => useSpaceDragPan({ current: container }, () => handle, on), {
      initialProps: { on: active },
    });
    return { container, card, handle, cardPointerDown, hook, viewport: () => viewport };
  }

  it('pans by the pointer delta over a card without letting the card see the drag', () => {
    const { card, handle, cardPointerDown, viewport } = setup(true);
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 40, clientY: -20 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 40, clientY: -20 });

    expect(cardPointerDown).not.toHaveBeenCalled();
    expect(handle.setViewport).toHaveBeenCalled();
    expect(viewport()).toEqual({ x: 130, y: 20, zoom: 0.5 });
  });

  it('does nothing until Space is held', () => {
    const { card, handle, cardPointerDown } = setup(false);
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 40, clientY: 40 });

    expect(cardPointerDown).toHaveBeenCalledOnce();
    expect(handle.setViewport).not.toHaveBeenCalled();
  });
});
