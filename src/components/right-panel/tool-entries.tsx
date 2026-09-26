import { FileDiff, Folder, Globe, MessageCirclePlus, SquareTerminal, type LucideIcon } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

type ToolEntry = { id: 'review' | 'terminal' | 'browser' | 'files' | 'side-chat'; label: string; Icon: LucideIcon };

// Only Terminal exists so far; the others are listed so the panel shows its
// intended shape before they land.
const TOOL_ENTRIES: readonly ToolEntry[] = [
  { id: 'review', label: 'Review', Icon: FileDiff },
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminal },
  { id: 'browser', label: 'Browser', Icon: Globe },
  { id: 'files', label: 'Files', Icon: Folder },
  { id: 'side-chat', label: 'Side chat', Icon: MessageCirclePlus },
];

// The hint is decoration for sighted users; the shortcut itself is exposed
// through `aria-keyshortcuts` and unavailability through `disabled`.
function Hint({ available }: { available: boolean }) {
  return (
    <span aria-hidden className={cn('ml-auto rounded border border-sidebar-border px-1.5 text-[11px] leading-4 text-muted-foreground', available ? 'font-mono' : 'font-sans')}>
      {available ? 'Ctrl+`' : 'Soon'}
    </span>
  );
}

export function ToolList({ onTerminal }: { onTerminal: () => void }) {
  return (
    <div aria-label="Add a tool" className="w-full max-w-sm space-y-2" role="menu">
      {TOOL_ENTRIES.map(({ id, label, Icon }) => {
        const available = id === 'terminal';
        return (
          <button
            aria-keyshortcuts={available ? 'Control+`' : undefined}
            className={cn(
              'flex h-10 w-full items-center gap-3 rounded-lg bg-sidebar-accent/60 px-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring',
              available ? 'hover:bg-sidebar-accent' : 'cursor-default text-muted-foreground',
            )}
            disabled={!available}
            key={id}
            onClick={available ? onTerminal : undefined}
            role="menuitem"
            type="button"
          >
            <Icon aria-hidden className="size-4" />
            {label}
            <Hint available={available} />
          </button>
        );
      })}
    </div>
  );
}

export function ToolMenuItems({ onTerminal }: { onTerminal: () => void }) {
  return (
    <>
      {TOOL_ENTRIES.map(({ id, label, Icon }) => {
        const available = id === 'terminal';
        return (
          <DropdownMenuItem
            aria-keyshortcuts={available ? 'Control+`' : undefined}
            // The menu item's default dims disabled entries to 50%; the spec
            // keeps them readable in the secondary text colour instead.
            className="gap-3 data-[disabled]:text-muted-foreground data-[disabled]:opacity-100"
            disabled={!available}
            key={id}
            onSelect={available ? onTerminal : undefined}
          >
            <Icon aria-hidden />
            {label}
            <Hint available={available} />
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
