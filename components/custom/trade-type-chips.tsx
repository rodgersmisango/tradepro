'use client';

import { useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useScrollOverflow } from '@/hooks/use-scroll-overflow';
import { cn } from '@/lib/utils';

interface TradeTypeOption<T extends string> {
  value: T;
  label: string;
}

/** What the row sits on, so the edge fade blends into it instead of banding. */
type Backdrop = 'background' | 'card';

interface TradeTypeChipsProps<T extends string> {
  value: T;
  options: TradeTypeOption<T>[];
  onValueChange: (value: T) => void;
  /** Surface the row is rendered on. Defaults to the page background. */
  backdrop?: Backdrop;
  /** Applied to the scroll container, for layout at the call site. */
  className?: string;
}

/** How far one chevron press moves the row, as a fraction of the visible width. */
const SCROLL_STEP_RATIO = 0.75;

// Written out in full because Tailwind scans source for complete class names.
const FADE: Record<Backdrop, { left: string; right: string }> = {
  background: {
    left: 'bg-gradient-to-r from-background via-background to-transparent',
    right: 'bg-gradient-to-l from-background via-background to-transparent',
  },
  card: {
    left: 'bg-gradient-to-r from-card via-card to-transparent',
    right: 'bg-gradient-to-l from-card via-card to-transparent',
  },
};

export function TradeTypeChips<T extends string>({
  value,
  options,
  onValueChange,
  backdrop = 'background',
  className,
}: TradeTypeChipsProps<T>) {
  const { ref, canScrollLeft, canScrollRight } = useScrollOverflow<HTMLDivElement>();

  const scrollBy = useCallback(
    (direction: -1 | 1) => {
      const el = ref.current;
      if (!el) return;
      el.scrollBy({ left: direction * el.clientWidth * SCROLL_STEP_RATIO, behavior: 'smooth' });
    },
    [ref]
  );

  return (
    // `relative` anchors the chevrons, which overlay the row's edges rather than
    // taking layout width — the row is already tight in the longer locales.
    <div className={cn('relative', className)}>
      <div
        ref={ref}
        className="overflow-x-auto pb-0.5 [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        <ToggleGroup
          type="single"
          value={value}
          onValueChange={(v) => {
            // Use options lookup so onValueChange receives the correctly-typed T value
            const opt = options.find((o) => o.value === v);
            if (opt) onValueChange(opt.value);
          }}
          className="w-max gap-1.5 sm:gap-2"
        >
          {options.map((opt) => (
            <ToggleGroupItem
              key={opt.value}
              value={opt.value}
              className="h-8 whitespace-nowrap rounded-full border border-input bg-background px-3 text-xs font-medium data-[state=on]:border-foreground data-[state=on]:bg-foreground data-[state=on]:text-background hover:bg-muted sm:h-10 sm:px-4 sm:text-sm"
            >
              {opt.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <ScrollAffordance
        side="left"
        backdrop={backdrop}
        visible={canScrollLeft}
        onScroll={() => scrollBy(-1)}
      />
      <ScrollAffordance
        side="right"
        backdrop={backdrop}
        visible={canScrollRight}
        onScroll={() => scrollBy(1)}
      />
    </div>
  );
}

function ScrollAffordance({
  side,
  backdrop,
  visible,
  onScroll,
}: {
  side: 'left' | 'right';
  backdrop: Backdrop;
  visible: boolean;
  onScroll: () => void;
}) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;

  return (
    <button
      type="button"
      data-testid={`trade-type-scroll-${side}`}
      // The row is already reachable by wheel, touch and arrow keys, so the
      // chevron is a redundant pointer shortcut. Keeping it out of the tab order
      // and hidden from assistive tech avoids announcing a control that does
      // nothing keyboard users cannot already do.
      tabIndex={-1}
      aria-hidden
      onClick={onScroll}
      className={cn(
        // The chevron sits above the chips and fades them out underneath, so the
        // row reads as continuing past the edge rather than ending there.
        'absolute inset-y-0 flex w-8 items-center transition-opacity',
        side === 'left' ? 'left-0 justify-start' : 'right-0 justify-end',
        FADE[backdrop][side],
        // Faded out rather than unmounted so toggling never reflows the row.
        // `hidden` alone would not do it: the `flex` above outranks the user
        // agent's `display:none`, which left the fade painting over the first
        // chip at rest. `invisible` also stops it swallowing clicks.
        visible ? 'opacity-100' : 'pointer-events-none invisible opacity-0'
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}
