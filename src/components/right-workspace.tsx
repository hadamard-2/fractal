import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileDiff, Folder, Globe, PanelRight, Plus, SquareTerminal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TerminalView } from '@/components/terminal-view';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type TerminalTab = { id: string; cwd: string | null; number: number; shell?: string };
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const MIN_CONVERSATION = 420;
const clamp = (value: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value));

function ToolChoices({ onTerminal }: { onTerminal: () => void }) {
  return (
    <>
      <DropdownMenuItem disabled><FileDiff />Review</DropdownMenuItem>
      <DropdownMenuItem onSelect={onTerminal}><SquareTerminal />Terminal</DropdownMenuItem>
      <DropdownMenuItem disabled><Globe />Browser</DropdownMenuItem>
      <DropdownMenuItem disabled><Folder />Files</DropdownMenuItem>
    </>
  );
}

export function RightWorkspace({ open, active, projectPath, onOpenChange, children }: {
  open: boolean;
  active: boolean;
  projectPath: string | null;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [chosenWidth, setChosenWidth] = useState<number | null>(null);
  const nextNumber = useRef(1);
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setContainerWidth(root.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const width = chosenWidth ?? clamp(containerWidth * 0.4);
  const split = open && containerWidth >= width + MIN_CONVERSATION;
  const addTerminal = () => {
    const id = crypto.randomUUID();
    const number = nextNumber.current++;
    setTabs((previous) => [...previous, { id, cwd: projectPath, number }]);
    setSelectedId(id);
  };
  const closeTab = (id: string) => {
    setTabs((previous) => {
      const index = previous.findIndex((tab) => tab.id === id);
      const next = previous.filter((tab) => tab.id !== id);
      if (selectedId === id) setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null);
      return next;
    });
  };
  const resize = (next: number) => {
    const max = split ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, containerWidth - MIN_CONVERSATION)) : MAX_WIDTH;
    setChosenWidth(Math.min(max, clamp(next)));
  };

  return (
    <div ref={rootRef} className="relative flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      <Button
        aria-label={open ? 'Close right panel' : 'Open right panel'}
        aria-expanded={open}
        className="absolute right-36 top-[26px] z-40 size-7"
        onClick={() => onOpenChange(!open)}
        size="icon"
        variant="ghost"
      >
        <PanelRight aria-hidden className="size-4" />
      </Button>
      <aside
        aria-hidden={!open || !active}
        aria-label="Right workspace"
        className={split ? 'relative z-20 shrink-0 p-2' : 'absolute inset-y-0 right-0 z-20 p-2'}
        role="complementary"
        style={{ width: `${width}px`, visibility: open ? 'visible' : 'hidden', pointerEvents: open ? undefined : 'none' }}
      >
        <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-sm">
          <div className="flex h-[68px] min-h-[68px] items-center gap-1 overflow-hidden border-b border-sidebar-border px-2 pr-40">
            <div aria-label="Right workspace tabs" className="scrollbar-minimal flex min-w-0 items-center gap-1 overflow-x-auto" role="tablist">
              {tabs.map((tab) => {
                const label = tab.shell ? `${tab.shell} · Terminal ${tab.number}` : `Terminal ${tab.number}`;
                return (
                  <div className="flex shrink-0 items-center rounded-md bg-sidebar-accent/50" key={tab.id}>
                    <button aria-controls={`terminal-panel-${tab.id}`} aria-selected={selectedId === tab.id} className="max-w-40 truncate rounded-md px-2 py-1 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring data-[selected=true]:bg-sidebar-accent" data-selected={selectedId === tab.id} id={tab.id} onClick={() => setSelectedId(tab.id)} role="tab" type="button">{label}</button>
                    <button aria-label={`Close ${label}`} className="rounded-md p-1 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={() => closeTab(tab.id)} type="button"><X aria-hidden className="size-3" /></button>
                  </div>
                );
              })}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button aria-label="Add tool" className="size-7" size="icon" variant="ghost"><Plus aria-hidden className="size-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start"><ToolChoices onTerminal={addTerminal} /></DropdownMenuContent>
            </DropdownMenu>
          </div>
          {tabs.length === 0 ? (
            <div className="flex min-h-0 flex-1 items-center justify-center p-4">
              <div aria-label="Add a tool" className="w-full max-w-72 space-y-1" role="menu">
                <button className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-muted-foreground opacity-50" disabled role="menuitem" type="button"><FileDiff aria-hidden className="size-4" />Review</button>
                <button className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring" onClick={addTerminal} role="menuitem" type="button"><SquareTerminal aria-hidden className="size-4" />Terminal</button>
                <button className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-muted-foreground opacity-50" disabled role="menuitem" type="button"><Globe aria-hidden className="size-4" />Browser</button>
                <button className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-muted-foreground opacity-50" disabled role="menuitem" type="button"><Folder aria-hidden className="size-4" />Files</button>
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-hidden">
              {tabs.map((tab) => <div aria-labelledby={tab.id} className="h-full" hidden={selectedId !== tab.id} id={`terminal-panel-${tab.id}`} key={tab.id} role="tabpanel"><TerminalView cwd={tab.cwd} id={tab.id} onShellReady={({ shell }) => setTabs((previous) => previous.map((item) => item.id === tab.id ? { ...item, shell: shell.split(/[\\/]/).pop() || undefined } : item))} visible={open && active && selectedId === tab.id} /></div>)}
            </div>
          )}
        </div>
        <div
          aria-label="Resize right panel"
          aria-orientation="vertical"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={Math.round(width)}
          className="absolute inset-y-2 left-0 z-30 w-2 cursor-col-resize touch-none"
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); resize(width + 16); }
            if (event.key === 'ArrowRight') { event.preventDefault(); resize(width - 16); }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            drag.current = { x: event.clientX, width };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => { if (drag.current) resize(drag.current.width + drag.current.x - event.clientX); }}
          onPointerUp={() => { drag.current = null; }}
          role="separator"
          tabIndex={0}
        />
      </aside>
    </div>
  );
}
