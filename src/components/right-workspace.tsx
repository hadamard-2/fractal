import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Plus } from 'lucide-react';
import { ToolList, ToolMenuItems } from '@/components/right-panel/tool-entries';
import { TerminalTabs, type TerminalTab } from '@/components/right-panel/terminal-tabs';
import { TerminalView } from '@/components/terminal-view';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PANEL_MIN_WIDTH, clampPanelWidth, defaultPanelWidth, panelLayout } from '@/renderer/right-panel-layout';

// An element's width and left edge, kept current. Falls back to window
// resizes where ResizeObserver is missing.
function useBox(ref: RefObject<HTMLElement | null> | undefined) {
  const [box, setBox] = useState({ width: 0, left: 0 });
  useEffect(() => {
    const element = ref?.current;
    if (!element) { setBox({ width: 0, left: 0 }); return; }
    const measure = () => {
      const { width, left } = element.getBoundingClientRect();
      setBox((previous) => (previous.width === width && previous.left === left ? previous : { width, left }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return box;
}

/**
 * The right panel, rendered once around every mode. It measures itself and
 * the active mode's content inset here rather than in App, so a left-sidebar
 * animation re-renders only the panel: `children` arrives unchanged and React
 * skips it.
 */
export function RightWorkspace({ open, onOpenChange, width: chosenWidth, onWidthChange, onResizingChange, leftInsetRef, projectPath, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Controlled by App, which also places the mode toggle against it. Null
  // until the panel first opens.
  width: number | null;
  onWidthChange: (width: number) => void;
  onResizingChange: (resizing: boolean) => void;
  // The active mode's main content; its left edge is where the space beside
  // a left sidebar begins. Omitted in modes without one.
  leftInsetRef?: RefObject<HTMLElement | null>;
  projectPath: string | null;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const root = useBox(rootRef);
  const inset = useBox(leftInsetRef);
  const leftInset = leftInsetRef ? Math.max(0, inset.left - root.left) : 0;
  const width = chosenWidth ?? defaultPanelWidth(root.width, leftInset);
  const layout = panelLayout({ open, width, containerWidth: root.width, leftInset });

  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; token: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const nextNumber = useRef(1);
  const nextFocus = useRef(1);
  const drag = useRef<{ x: number; width: number } | null>(null);

  // Fix the width the first time the panel opens, so later changes to the
  // left sidebar or the mode don't move it. A layout effect, so App places
  // the mode toggle before the first open paints.
  useLayoutEffect(() => {
    if (open && chosenWidth === null) onWidthChange(width);
  }, [open, chosenWidth, width, onWidthChange]);

  const focusTerminal = (id: string) => setFocusRequest({ id, token: nextFocus.current++ });
  const addTerminal = () => {
    const id = crypto.randomUUID();
    const number = nextNumber.current++;
    setTabs((previous) => [...previous, { id, cwd: projectPath, number }]);
    setSelectedId(id);
    focusTerminal(id);
  };
  const updateTab = (id: string, patch: Partial<TerminalTab>) => {
    setTabs((previous) => previous.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
  };
  const closeTab = (id: string) => {
    setTabs((previous) => {
      const index = previous.findIndex((tab) => tab.id === id);
      const next = previous.filter((tab) => tab.id !== id);
      if (selectedId === id) setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null);
      return next;
    });
  };
  const resize = (next: number) => onWidthChange(Math.min(layout.maxWidth, clampPanelWidth(next)));
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    onResizingChange(false);
  };

  // Ctrl+` — VS Code's terminal toggle. Read through a ref so the listener,
  // registered once, always sees the latest tabs and open state.
  const toggleTerminal = useRef<() => void>(() => undefined);
  toggleTerminal.current = () => {
    const focused = document.activeElement;
    const focusInTerminal = focused instanceof Element
      && focused.closest('[data-slot="terminal"]') !== null
      && panelRef.current?.contains(focused) === true;
    if (open && focusInTerminal) { onOpenChange(false); return; }
    if (!open) onOpenChange(true);
    const selected = tabs.find((tab) => tab.id === selectedId);
    if (selected) focusTerminal(selected.id);
    else addTerminal();
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Backquote' || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      toggleTerminal.current();
    };
    // Capture phase, so a focused terminal never receives the keystroke.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden" ref={rootRef}>
      {/*
        Content headers read --app-bar-reserve to keep their titles clear of
        the mode and panel toggles, which float over the header row.
      */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={{ '--app-bar-reserve': `${layout.headerReserve}px` } as CSSProperties}>
        {children}
      </div>
      {/*
        The panel keeps its full width and slides; this in-flow gap is what
        narrows the content beside it, like the left sidebar's gap. Motion
        for both lives in index.css.
      */}
      <div aria-hidden className="shrink-0" data-slot="right-panel-gap" style={{ width: layout.split ? width : 0 }} />
      <aside
        aria-hidden={!open}
        aria-label="Right workspace"
        className="absolute inset-y-0 right-0 z-20 p-2"
        data-open={open || undefined}
        data-slot="right-panel"
        inert={!open}
        ref={panelRef}
        role="complementary"
        style={{ width, transform: open ? undefined : 'translateX(100%)', visibility: open ? 'visible' : 'hidden' }}
      >
        <TooltipProvider delayDuration={500}>
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-sm">
            {/*
              The tab row sits on the app bar's centerline, level with the
              mode toggle, the panel toggle, and Execute's title: the band's
              centre is --app-bar-offset + --app-bar-height / 2 below this
              panel's top, less the aside's 8px inset, plus half the 32px row
              because the row is bottom-aligned. pr-10 clears the panel
              toggle, which App floats over this corner.
            */}
            <div className="flex shrink-0 items-end gap-1 pr-10 pl-2" style={{ height: 'calc(var(--app-bar-offset) + var(--app-bar-height) / 2 + 8px)' }}>
              <TerminalTabs onClose={closeTab} onSelect={setSelectedId} selectedId={selectedId} tabs={tabs} />
              {tabs.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button aria-label="Add tool" className="size-8 shrink-0" size="icon" variant="ghost"><Plus aria-hidden className="size-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56"><ToolMenuItems onTerminal={addTerminal} /></DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {tabs.length === 0 ? (
              <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                <ToolList onTerminal={addTerminal} />
              </div>
            ) : (
              <div className="mx-2 mt-1 mb-2 min-h-0 flex-1 overflow-hidden rounded-md border border-sidebar-border">
                {tabs.map((tab) => (
                  <div aria-labelledby={tab.id} className="h-full" hidden={selectedId !== tab.id} id={`terminal-panel-${tab.id}`} key={tab.id} role="tabpanel">
                    <TerminalView
                      cwd={tab.cwd}
                      focusToken={focusRequest?.id === tab.id ? focusRequest.token : 0}
                      id={tab.id}
                      onExitedChange={(exited) => updateTab(tab.id, { exited })}
                      onShellReady={({ shell, cwd }) => updateTab(tab.id, { shell: shell.split(/[\\/]/).pop() || undefined, startedIn: cwd })}
                      visible={open && selectedId === tab.id}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </TooltipProvider>
        <div
          aria-label="Resize right panel"
          aria-orientation="vertical"
          aria-valuemax={Math.round(layout.maxWidth)}
          aria-valuemin={PANEL_MIN_WIDTH}
          aria-valuenow={Math.round(width)}
          className="absolute inset-y-2 left-0 z-30 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 hover:after:bg-sidebar-border focus-visible:after:bg-ring data-[dragging=true]:after:bg-sidebar-border"
          data-dragging={dragging}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') { event.preventDefault(); resize(width + 16); }
            if (event.key === 'ArrowRight') { event.preventDefault(); resize(width - 16); }
          }}
          onLostPointerCapture={endDrag}
          onPointerCancel={endDrag}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            drag.current = { x: event.clientX, width };
            setDragging(true);
            onResizingChange(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => { if (drag.current) resize(drag.current.width + drag.current.x - event.clientX); }}
          onPointerUp={endDrag}
          role="separator"
          tabIndex={0}
        />
      </aside>
    </div>
  );
}
