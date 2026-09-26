import { SquareTerminal, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export type TerminalTab = {
  id: string;
  // The directory requested at creation; null lets the main process choose.
  cwd: string | null;
  // Creation order, never reused, so labels stay stable as tabs close.
  number: number;
  // The shell's name, once it has started.
  shell?: string;
  // The directory the shell actually started in, once known.
  startedIn?: string;
  exited?: boolean;
};

export function terminalTabLabel(tab: TerminalTab): string {
  const base = tab.shell ?? 'Terminal';
  return tab.number > 1 ? `${base} ${tab.number}` : base;
}

export function TerminalTabs({ tabs, selectedId, onSelect, onClose }: {
  tabs: TerminalTab[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div aria-label="Right workspace tabs" className="scrollbar-minimal flex min-w-0 items-center gap-1 overflow-x-auto" role="tablist">
      {tabs.map((tab) => {
        const label = terminalTabLabel(tab);
        const selected = selectedId === tab.id;
        return (
          <div
            className="group flex h-8 shrink-0 items-center rounded-md border border-transparent text-xs text-muted-foreground hover:text-foreground data-[selected=true]:border-sidebar-border data-[selected=true]:bg-background data-[selected=true]:text-foreground"
            data-selected={selected}
            key={tab.id}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              onClose(tab.id);
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-controls={`terminal-panel-${tab.id}`}
                  aria-selected={selected}
                  className="flex h-full max-w-40 items-center gap-1.5 rounded-md pr-1 pl-2 focus-visible:outline-2 focus-visible:outline-ring"
                  id={tab.id}
                  onClick={() => onSelect(tab.id)}
                  role="tab"
                  type="button"
                >
                  <SquareTerminal aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                  {tab.exited && (
                    <>
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/70" />
                      <span className="sr-only"> (exited)</span>
                    </>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{tab.startedIn ?? tab.cwd ?? 'App working directory'}</TooltipContent>
            </Tooltip>
            <button
              aria-label={`Close ${label}`}
              className="mr-1 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100 group-data-[selected=true]:opacity-100"
              onClick={() => onClose(tab.id)}
              type="button"
            >
              <X aria-hidden className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
