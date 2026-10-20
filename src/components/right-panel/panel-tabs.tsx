import { FileDiff, MessageCircle, SquareTerminal, X } from 'lucide-react';
import { FileTypeIcon, FolderTypeIcon } from '@/components/code/file-icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { absoluteProjectPath, basename } from '@/renderer/file-display';
import type { PanelTab } from '@/renderer/panel-tabs';
import { terminalTabLabel } from './terminal-tabs';

export function panelTabLabel(tab: PanelTab, terminalCount: number): string {
  if (tab.kind === 'terminal') return terminalTabLabel(tab, terminalCount);
  if (tab.kind === 'changes') return 'Changes';
  if (tab.kind === 'side-chat') return 'Side chat';
  return tab.path === null ? 'Files' : basename(tab.path);
}

export const tabPanelId = (tab: PanelTab): string => (tab.kind === 'terminal' ? `terminal-panel-${tab.id}` : `panel-${tab.id}`);

const TOOLTIP_TEXT_LIMIT = 80;

// A side chat's branch point, by its first line, which can be a whole paragraph.
function branchPointTooltip(text: string | undefined): string {
  const line = text?.split('\n')[0] ?? '';
  if (!line) return 'Side chat';
  return line.length > TOOLTIP_TEXT_LIMIT ? `${line.slice(0, TOOLTIP_TEXT_LIMIT)}…` : line;
}

function tooltipFor(tab: PanelTab): string {
  if (tab.kind === 'terminal') return tab.startedIn ?? tab.cwd;
  if (tab.kind === 'changes') return tab.projectPath;
  if (tab.kind === 'side-chat') return branchPointTooltip(tab.branchPointText);
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
        return (
          <div
            className="group relative flex h-8 shrink-0 items-center text-xs text-muted-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 hover:text-foreground data-[selected=true]:text-foreground data-[selected=true]:after:bg-primary"
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
                  {tab.kind === 'terminal' && <SquareTerminal aria-hidden className="size-3.5 shrink-0" />}
                  {tab.kind === 'changes' && <FileDiff aria-hidden className="size-3.5 shrink-0" />}
                  {tab.kind === 'side-chat' && <MessageCircle aria-hidden className="size-3.5 shrink-0" />}
                  {tab.kind === 'file' && (tab.path === null
                    ? <FolderTypeIcon className="size-3.5 shrink-0" name={basename(tab.projectPath)} />
                    : <FileTypeIcon className="size-3.5 shrink-0" path={tab.path} />)}
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
