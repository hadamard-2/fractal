import { Brain, Laptop, Map } from 'lucide-react';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export type Mode = 'execute' | 'map' | 'explain';

// `group` clusters items visually: items sharing a group sit close together,
// and the gap widens between different groups. Execute and Map read as one
// pair; Explain stands apart.
const MODES = [
  { value: 'execute', label: 'Execute', Icon: Laptop, group: 1 },
  { value: 'map', label: 'Map', Icon: Map, group: 1 },
  { value: 'explain', label: 'Explain', Icon: Brain, group: 2 },
] as const satisfies readonly {
  value: Mode;
  label: string;
  Icon: typeof Laptop;
  group: number;
}[];

/** The modes in the toggle's left-to-right order, which Mod+1–3 follow. */
export const MODE_ORDER: readonly Mode[] = MODES.map((mode) => mode.value);

const ITEM_WIDTH = 34;
const GAP_WITHIN_GROUP = 4;
const GAP_BETWEEN_GROUPS = 14;

// The gap after each item -- tight within a group, wider between groups --
// determines both the margin on that item and how far the pill has to slide
// to reach the next one, so both are derived from the same array.
const trailingGaps = MODES.map((mode, i) => {
  const next = MODES[i + 1];
  if (!next) return 0;
  return mode.group === next.group ? GAP_WITHIN_GROUP : GAP_BETWEEN_GROUPS;
});

const itemOffsets = MODES.reduce<number[]>((offsets, _, i) => {
  const previous = offsets[i - 1] ?? 0;
  const step = i === 0 ? 0 : ITEM_WIDTH + trailingGaps[i - 1];
  offsets.push(previous + step);
  return offsets;
}, []);

// The toggle's rendered width: the last item's offset plus its own width,
// plus the group's `p-1` on both sides. The right panel reads it to keep
// header titles clear of the toggle.
export const MODE_TOGGLE_WIDTH = itemOffsets[itemOffsets.length - 1] + ITEM_WIDTH + 8;

// A divider renders in the middle of any gap that separates two different
// groups (not the tight gap within one), so it only ever marks a real
// boundary and moves automatically if the grouping changes.
const dividerOffsets = MODES.flatMap((mode, i) => {
  const next = MODES[i + 1];
  if (!next || mode.group === next.group) return [];
  return [itemOffsets[i] + ITEM_WIDTH + trailingGaps[i] / 2];
});

type ModeToggleProps = {
  value: Mode;
  onValueChange: (value: Mode) => void;
};

export function ModeToggle({ value, onValueChange }: ModeToggleProps) {
  const activeIndex = MODES.findIndex((m) => m.value === value);

  return (
    <ToggleGroup
      type="single"
      value={value}
      // Radix emits "" when the active item is pressed again; ignoring that
      // keeps this a two-way switch rather than letting it clear itself.
      onValueChange={(next) => next && onValueChange(next as Mode)}
      aria-label="Mode"
      size="sm"
      className="relative w-fit gap-0 rounded-lg bg-secondary p-1"
    >
      {/*
        The white pill is one element that slides, rather than a background on
        each item, so the change animates. Its offset comes from the same
        `itemOffsets` array used for the items' own spacing, so the grouped
        (tight) and separated (wide) gaps stay in sync automatically.
      */}
      <span
        aria-hidden
        className="absolute inset-y-1 left-1 h-8 w-[34px] rounded-md bg-white shadow-sm transition-transform duration-300 [transition-timing-function:cubic-bezier(0.34,1.4,0.64,1)]"
        style={{ transform: `translateX(${itemOffsets[activeIndex]}px)` }}
      />

      {dividerOffsets.map((center) => (
        <span
          key={center}
          aria-hidden
          className="absolute inset-y-2 w-px bg-border"
          style={{ left: `calc(0.25rem + ${center}px)` }}
        />
      ))}

      {MODES.map(({ value: mode, label, Icon }, i) => (
        // Item backgrounds are cleared so the sliding pill shows through; the
        // label is dropped from the UI but kept as the accessible name.
        <ToggleGroupItem
          key={mode}
          value={mode}
          aria-label={label}
          style={{ marginRight: trailingGaps[i] }}
          className="relative z-10 h-8 w-[34px] shrink-0 rounded-md! bg-transparent! px-0! text-muted-foreground transition-colors hover:text-foreground data-[state=on]:text-neutral-900 data-[state=on]:hover:text-neutral-900"
        >
          <Icon />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
