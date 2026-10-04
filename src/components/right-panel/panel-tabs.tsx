import { FileText, SquareTerminal, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { absoluteProjectPath, basename } from '@/renderer/file-display';
import type { PanelTab } from '@/renderer/panel-tabs';
import { terminalTabLabel } from './terminal-tabs';

export function panelTabLabel(tab: PanelTab, terminalCount: number): string {
  if (tab.kind === 'terminal') return terminalTabLabel(tab, terminalCount);
  return tab.path === null ? 'Files' : basename(tab.path);
}

export const tabPanelId = (tab: PanelTab): string => (tab.kind === 'terminal' ? `terminal-panel-${tab.id}` : `panel-${tab.id}`);

function tooltipFor(tab: PanelTab): string {
  if (tab.kind === 'terminal') return tab.startedIn ?? tab.cwd ?? 'App working directory';
  return tab.path === null ? tab.projectPath : absoluteProjectPath(tab.projectPath, tab.path);
}

export function PanelTabs({ tabs, selectedId, onSelect, onClose, onPin }: {
  tabs: PanelTab[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
}) {
  const terminalCount = tabs.filter((tab) => tab.kind === 'terminal').length;
  return (
    <div aria-label="Right workspace tabs" className="flex min-w-0 items-center gap-1 overflow-x-auto" role="tablist">
      {tabs.map((tab) => {
        const label = panelTabLabel(tab, terminalCount);
        const selected = selectedId === tab.id;
        const preview = tab.kind === 'file' && tab.preview;
        const Icon = tab.kind === 'terminal' ? SquareTerminal : FileText;
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
                  aria-controls={tabPanelId(tab)}
                  aria-selected={selected}
                  className="flex h-full max-w-40 items-center gap-1.5 rounded-md pr-1 pl-2 focus-visible:outline-2 focus-visible:outline-ring"
                  id={tab.id}
                  onClick={() => onSelect(tab.id)}
                  onDoubleClick={tab.kind === 'file' ? () => onPin(tab.id) : undefined}
                  role="tab"
                  type="button"
                >
                  <Icon aria-hidden className="size-3.5 shrink-0" />
                  <span className={cn('truncate', preview && 'italic')}>{label}</span>
                  {preview && <span className="sr-only"> (preview)</span>}
                  {tab.kind === 'terminal' && tab.exited && (
                    <>
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/70" />
                      <span className="sr-only"> (exited)</span>
                    </>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{tooltipFor(tab)}</TooltipContent>
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
