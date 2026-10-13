'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ScrollOverflow {
  /** Content extends past the left edge — there is something to scroll back to. */
  canScrollLeft: boolean;
  /** Content extends past the right edge — there is something more to reveal. */
  canScrollRight: boolean;
}

/**
 * Tracks whether a horizontally scrollable element has content hidden off either
 * edge, so callers can render an affordance only when scrolling is actually
 * possible.
 *
 * Whether a row overflows depends on the rendered text, so it cannot be decided
 * at build time: translated labels are longer than their English originals (the
 * digits trade-type row fits in EN but not in FR). This measures the real box
 * instead, which keeps the affordance correct in every locale.
 */
export function useScrollOverflow<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [overflow, setOverflow] = useState<ScrollOverflow>({
    canScrollLeft: false,
    canScrollRight: false,
  });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    // Sub-pixel layout means scrollLeft rarely lands exactly on either bound, so
    // a 1px tolerance keeps the affordance from flickering at rest.
    const maxScroll = scrollWidth - clientWidth;
    setOverflow({
      canScrollLeft: scrollLeft > 1,
      canScrollRight: scrollLeft < maxScroll - 1,
    });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    measure();
    el.addEventListener('scroll', measure, { passive: true });

    // Re-measure when the box or its contents change size — a language switch
    // swaps the labels without remounting, and the viewport can be resized.
    // ResizeObserver is absent in some test environments, so fall back to the
    // window resize event rather than throwing.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => {
        el.removeEventListener('scroll', measure);
        window.removeEventListener('resize', measure);
      };
    }

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The scrolling box keeps its width while the content inside it grows, so
    // the content has to be observed too.
    if (el.firstElementChild) ro.observe(el.firstElementChild);

    return () => {
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, [measure]);

  return { ref, ...overflow, measure };
}
