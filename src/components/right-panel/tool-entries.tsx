import { FileDiff, Folder, Globe, MessageCirclePlus, SquareTerminal, type LucideIcon } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

type ToolId = 'review' | 'terminal' | 'browser' | 'files' | 'side-chat';
type ToolEntry = { id: ToolId; label: string; Icon: LucideIcon };

// Terminal and Files exist; the others are listed so the panel shows its intended shape before they land.
const TOOL_ENTRIES: readonly ToolEntry[] = [
  { id: 'review', label: 'Review', Icon: FileDiff },
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminal },
  { id: 'browser', label: 'Browser', Icon: Globe },
  { id: 'files', label: 'Files', Icon: Folder },
  { id: 'side-chat', label: 'Side chat', Icon: MessageCirclePlus },
];

type Handlers = { onTerminal: () => void; onFiles: () => void; filesAvailable: boolean };
type State = { onSelect?: () => void; hint?: string; shortcut?: string };

function stateOf(id: ToolId, { onTerminal, onFiles, filesAvailable }: Handlers): State {
  if (id === 'terminal') return { onSelect: onTerminal, hint: 'Ctrl+`', shortcut: 'Control+`' };
  if (id === 'files') return filesAvailable ? { onSelect: onFiles, hint: 'Ctrl+Shift+F', shortcut: 'Control+Shift+F' } : { hint: 'Open a project first' };
  return { hint: 'Soon' };
}

// The hint is decoration for sighted users; the shortcut itself is exposed
// through `aria-keyshortcuts` and unavailability through `disabled`.
function Hint({ text, shortcut }: { text?: string; shortcut: boolean }) {
  if (!text) return null;
  return (
    <span aria-hidden className={cn('ml-auto rounded border border-sidebar-border px-1.5 text-[11px] leading-4 text-muted-foreground', shortcut ? 'font-mono' : 'font-sans')}>
      {text}
    </span>
  );
}

export function ToolList(handlers: Handlers) {
  return (
    <div aria-label="Add a tool" className="w-full max-w-sm space-y-2" role="menu">
      {TOOL_ENTRIES.map(({ id, label, Icon }) => {
        const { onSelect, hint, shortcut } = stateOf(id, handlers);
        return (
          <button
            aria-keyshortcuts={shortcut}
            className={cn(
              'flex h-10 w-full items-center gap-3 rounded-lg bg-sidebar-accent/60 px-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring',
              onSelect ? 'hover:bg-sidebar-accent' : 'cursor-default text-muted-foreground',
            )}
            disabled={!onSelect}
            key={id}
            onClick={onSelect}
            role="menuitem"
            type="button"
          >
            <Icon aria-hidden className="size-4" />
            {label}
            <Hint shortcut={shortcut !== undefined} text={hint} />
          </button>
        );
      })}
    </div>
  );
}

export function ToolMenuItems(handlers: Handlers) {
  return (
    <>
      {TOOL_ENTRIES.map(({ id, label, Icon }) => {
        const { onSelect, hint, shortcut } = stateOf(id, handlers);
        return (
          <DropdownMenuItem
            aria-keyshortcuts={shortcut}
            // The menu item's default dims disabled entries to 50%; the spec
            // keeps them readable in the secondary text colour instead.
            className="gap-3 data-[disabled]:text-muted-foreground data-[disabled]:opacity-100"
            disabled={!onSelect}
            key={id}
            onSelect={onSelect}
          >
            <Icon aria-hidden />
            {label}
            <Hint shortcut={shortcut !== undefined} text={hint} />
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
