/**
 * Reveals a block the partner selected in the no-code editor without moving
 * the page that embeds the editor. `Element.scrollIntoView` scrolls every
 * scrollable ancestor, including ones in ancestor browsing contexts, so in the
 * App Builder wizard it scrolled the cross-origin parent page as well
 * (deriv-api-templates#241, deriv-blox#831). `scrollTo` on an in-frame scroller
 * only ever scrolls that scroller.
 *
 * Shared across all no-code templates via `@/lib/scroll-within-frame`.
 *
 * Kept import-free on purpose. The App Builder BFF copies this file into every
 * assembled partner app, and copies shared files only as `<name>.ts`/`.tsx`:
 * a non-TS dependency such as a `.mjs` file is followed by the detector, dropped
 * by the copier, and then breaks the partner's `next build`. Other `.ts` shared
 * files and packages like `@deriv/core` would work, but this helper needs
 * neither. `__tests__/scroll-within-frame.test.ts` fails if an import appears.
 */

function isScrollable(el: Element, view: Window): boolean {
  const { overflowY } = view.getComputedStyle(el);
  return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
}

function nearestScroller(el: HTMLElement): Element | null {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  if (view) {
    // <body>'s overflow propagates to the viewport, so scrolling it moves nothing; use scrollingElement.
    for (let node = el.parentElement; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
      if (isScrollable(node, view)) return node;
    }
  }
  return null;
}

/** Smoothly centres `el` vertically in its nearest in-frame scroll container. */
export function centerInScrollContainer(el: HTMLElement): void {
  const doc = el.ownerDocument;
  const elRect = el.getBoundingClientRect();
  const scroller = nearestScroller(el);

  if (scroller) {
    const viewTop = scroller.getBoundingClientRect().top + scroller.clientTop;
    const top = scroller.scrollTop + (elRect.top - viewTop) - (scroller.clientHeight - elRect.height) / 2;
    scroller.scrollTo({ top, behavior: 'smooth' });
    return;
  }

  const root = doc.scrollingElement;
  if (!root) return;
  const top = root.scrollTop + elRect.top - (doc.documentElement.clientHeight - elRect.height) / 2;
  root.scrollTo({ top, behavior: 'smooth' });
}
