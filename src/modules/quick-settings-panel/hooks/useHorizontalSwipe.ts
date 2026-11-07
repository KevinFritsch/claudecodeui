import { useEffect, useRef } from 'react';

const MIN_DISTANCE = 70;
const MAX_DRIFT = 45;
const MAX_DURATION_MS = 700;

/** True when the touch started somewhere a horizontal swipe already means something (text, code, a scrollable strip). */
function startsInHorizontalScroller(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== document.body) {
    if (el.matches('input, textarea, select, pre, code, [contenteditable="true"], [data-no-swipe], .xterm')) return true;
    if (el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 2) {
      const overflow = getComputedStyle(el).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') return true;
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * Kvn: quick horizontal swipes on touch screens (mobile only). A swipe from
 * right to left calls `onSwipeLeft`, left to right `onSwipeRight`. Swipes that
 * start in inputs, code, terminals or horizontally scrollable areas are left
 * to those elements.
 */
export function useHorizontalSwipe(
  enabled: boolean,
  handlers: { onSwipeLeft: () => void; onSwipeRight: () => void },
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return undefined;
    let start: { x: number; y: number; t: number } | null = null;

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || startsInHorizontalScroller(event.target)) {
        start = null;
        return;
      }
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY, t: Date.now() };
    };
    const onEnd = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      const quick = Date.now() - start.t < MAX_DURATION_MS;
      start = null;
      if (!quick || Math.abs(dx) < MIN_DISTANCE || Math.abs(dy) > MAX_DRIFT) return;
      if (dx < 0) handlersRef.current.onSwipeLeft();
      else handlersRef.current.onSwipeRight();
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
    };
  }, [enabled]);
}
