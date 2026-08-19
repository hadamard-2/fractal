import { Brain, Laptop } from 'lucide-react';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export type Mode = 'execute' | 'explain';

const MODES = [
  { value: 'execute', label: 'Execute', Icon: Laptop },
  { value: 'explain', label: 'Explain', Icon: Brain },
] as const satisfies readonly { value: Mode; label: string; Icon: typeof Laptop }[];

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
      className="relative w-fit gap-1.5 rounded-lg bg-secondary p-1"
    >
      {/*
        The white pill is one element that slides, rather than a background on
        each item, so the change animates. Items are 34px wide (1px extra on
        each side of the 32px square) with a 6px gap between them, so a step
        is 34 + 6 = 40px -- not a plain 100% translate, which would only cover
        the item and land short by the gap.
      */}
      <span
        aria-hidden
        className="absolute inset-y-1 left-1 h-8 w-[34px] rounded-md bg-white shadow-sm transition-transform duration-200 ease-out"
        style={{ transform: `translateX(${activeIndex * 40}px)` }}
      />

      {MODES.map(({ value: mode, label, Icon }) => (
        // Item backgrounds are cleared so the sliding pill shows through; the
        // label is dropped from the UI but kept as the accessible name.
        <ToggleGroupItem
          key={mode}
          value={mode}
          aria-label={label}
          className="relative z-10 h-8 w-[34px] shrink-0 rounded-md! bg-transparent! px-0! text-muted-foreground transition-colors hover:text-foreground data-[state=on]:text-neutral-900 data-[state=on]:hover:text-neutral-900"
        >
          <Icon />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
