import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { ListTree, Plus } from 'lucide-react';
import { FilesPane } from '@/components/right-panel/files/files-pane';
import { PanelTabs } from '@/components/right-panel/panel-tabs';
import { ToolList, ToolMenuItems } from '@/components/right-panel/tool-entries';
import { TerminalLauncherContext, type OpenTerminalWith } from '@/components/right-panel/terminal-launcher';
import { TerminalView } from '@/components/terminal-view';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { activeTerminalId, addTerminalTab, closeTab, emptyPanelTabs, openFile, openFilesTool, pinTab, selectTab, updateTerminalTab, type FilePanelTab, type PanelTabsState, type TerminalPanelTab } from '@/renderer/panel-tabs';
import { PANEL_MIN_WIDTH, clampPanelWidth, defaultPanelWidth, filesTreeDocked, panelLayout } from '@/renderer/right-panel-layout';

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

  const [panelTabs, setPanelTabs] = useState<PanelTabsState>(emptyPanelTabs);
  const [dockedTreeOpen, setDockedTreeOpen] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ id: string; token: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const nextFocus = useRef(1);
  const drag = useRef<{ x: number; width: number } | null>(null);

  // Fix the width the first time the panel opens, so later changes to the
  // left sidebar or the mode don't move it. A layout effect, so App places
  // the mode toggle before the first open paints.
  useLayoutEffect(() => {
    if (open && chosenWidth === null) onWidthChange(width);
  }, [open, chosenWidth, width, onWidthChange]);

  const { tabs, selectedId } = panelTabs;
  const selectedTab = tabs.find((tab) => tab.id === selectedId);
  const terminalTabs = tabs.filter((tab): tab is TerminalPanelTab => tab.kind === 'terminal');
  const fileTabs = tabs.filter((tab): tab is FilePanelTab => tab.kind === 'file');
  const selectedFileTab = selectedTab?.kind === 'file' ? selectedTab : undefined;
  const docked = filesTreeDocked(width);
  const treeShown = selectedFileTab !== undefined && (docked ? dockedTreeOpen : overlayOpen || selectedFileTab.path === null);

  // Tree state belongs to the project being browsed, so another project starts with its defaults.
  const selectedProject = selectedFileTab?.projectPath;
  useEffect(() => {
    setOverlayOpen(false);
    setDockedTreeOpen(true);
  }, [selectedProject]);

  const focusTerminal = (id: string) => setFocusRequest({ id, token: nextFocus.current++ });
  const addTerminal = (paste?: string) => {
    if (projectPath === null) return;
    const id = crypto.randomUUID();
    setPanelTabs((previous) => addTerminalTab(previous, id, projectPath, paste));
    focusTerminal(id);
  };
  // Read through a ref so the context value stays stable across renders.
  const openTerminalWith = useRef<OpenTerminalWith>(() => undefined);
  openTerminalWith.current = (text) => {
    if (projectPath === null) return;
    if (!open) onOpenChange(true);
    addTerminal(text);
  };
  const [launcher] = useState<OpenTerminalWith>(() => (text: string) => openTerminalWith.current(text));
  const openFiles = () => {
    if (projectPath === null) return;
    const id = crypto.randomUUID();
    setPanelTabs((previous) => openFilesTool(previous, projectPath, id));
  };
  const openProjectFile = (project: string, path: string, pinned: boolean) => {
    const id = crypto.randomUUID();
    setPanelTabs((previous) => openFile(previous, project, path, pinned, id));
  };
  const toggleTree = () => (docked ? setDockedTreeOpen((value) => !value) : setOverlayOpen((value) => !value));
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
    if (projectPath === null) return;
    const focused = document.activeElement;
    const focusInTerminal = focused instanceof Element
      && focused.closest('[data-slot="terminal"]') !== null
      && panelRef.current?.contains(focused) === true;
    if (open && focusInTerminal) { onOpenChange(false); return; }
    if (!open) onOpenChange(true);
    const terminalId = activeTerminalId(panelTabs);
    if (terminalId) {
      setPanelTabs((previous) => selectTab(previous, terminalId));
      focusTerminal(terminalId);
    } else addTerminal();
  };
  // Ctrl+Shift+F — opens the panel on the project's Files tool. Not a toggle:
  // it always lands on Files, so pressing it again is harmless.
  const showFiles = useRef<() => void>(() => undefined);
  showFiles.current = () => {
    if (projectPath === null) return;
    if (!open) onOpenChange(true);
    openFiles();
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.code === 'Backquote' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminal.current();
      } else if (event.code === 'KeyF' && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        showFiles.current();
      }
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={{ '--app-bar-reserve': layout.headerReserve } as CSSProperties}>
        <TerminalLauncherContext.Provider value={projectPath === null ? null : launcher}>{children}</TerminalLauncherContext.Provider>
      </div>
      {/*
        The panel keeps its full width and slides; this in-flow gap is what
        narrows the content beside it, like the left sidebar's gap. Motion
        for both lives in index.css.
      */}
      <div aria-hidden className="shrink-0" data-slot="right-panel-gap" style={{ width: layout.split ? width : 0 }} />
      {/*
        The panel hangs straight from the app bar, with no top inset, like the
        left sidebar: the bar is the window frame, and its right end holds the
        panel toggle and the OS window controls.
      */}
      <aside
        aria-hidden={!open}
        aria-label="Right workspace"
        className="absolute top-(--app-bar-height) right-0 bottom-0 z-20 px-2 pb-2"
        data-open={open || undefined}
        data-slot="right-panel"
        inert={!open}
        ref={panelRef}
        role="complementary"
        style={{ width, transform: open ? undefined : 'translateX(100%)', visibility: open ? 'visible' : 'hidden' }}
      >
        <TooltipProvider>
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-sm">
            {/*
              The tab row lines up with the left sidebar's header row. Both
              panels hang straight from the app bar behind a 1px border, and
              the sidebar's header (14px of top padding, then a 36px row)
              centres 32px below that border — where this 48px bottom-aligned
              row centres its 32px controls.
            */}
            <div className="flex h-12 shrink-0 items-end gap-1 px-2">
              {selectedFileTab && (
                <Button aria-label={treeShown ? 'Hide file tree' : 'Show file tree'} aria-pressed={treeShown} className="size-8 shrink-0" onClick={toggleTree} size="icon" variant="ghost">
                  <ListTree aria-hidden className="size-4" />
                </Button>
              )}
              <PanelTabs
                onClose={(id) => setPanelTabs((previous) => closeTab(previous, id))}
                onPin={(id) => setPanelTabs((previous) => pinTab(previous, id))}
                onSelect={(id) => setPanelTabs((previous) => selectTab(previous, id))}
                selectedId={selectedId}
                tabs={tabs}
              />
              {tabs.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button aria-label="Add tool" className="size-8 shrink-0" size="icon" variant="ghost"><Plus aria-hidden className="size-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56"><ToolMenuItems onFiles={openFiles} onTerminal={() => addTerminal()} projectOpen={projectPath !== null} /></DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {tabs.length === 0 ? (
              <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                <ToolList onFiles={openFiles} onTerminal={() => addTerminal()} projectOpen={projectPath !== null} />
              </div>
            ) : (
              <div className="mx-2 mt-1 mb-2 min-h-0 flex-1 overflow-hidden rounded-md border border-sidebar-border">
                {terminalTabs.map((tab) => (
                  <div aria-labelledby={tab.id} className="h-full" hidden={selectedId !== tab.id} id={`terminal-panel-${tab.id}`} key={tab.id} role="tabpanel">
                    <TerminalView
                      cwd={tab.cwd}
                      focusToken={focusRequest?.id === tab.id ? focusRequest.token : 0}
                      id={tab.id}
                      onPasted={() => setPanelTabs((previous) => updateTerminalTab(previous, tab.id, { paste: undefined }))}
                      paste={tab.paste}
                      onExitedChange={(exited) => setPanelTabs((previous) => updateTerminalTab(previous, tab.id, { exited }))}
                      onShellReady={({ shell, cwd }) => setPanelTabs((previous) => updateTerminalTab(previous, tab.id, { shell: shell.split(/[\\/]/).pop() || undefined, startedIn: cwd }))}
                      visible={open && selectedId === tab.id}
                    />
                  </div>
                ))}
                {fileTabs.length > 0 && (
                  <div className="h-full" hidden={!selectedFileTab}>
                    <FilesPane
                      docked={docked}
                      dockedTreeOpen={dockedTreeOpen}
                      onCloseOverlay={() => setOverlayOpen(false)}
                      onOpenFile={openProjectFile}
                      overlayOpen={overlayOpen}
                      selected={selectedFileTab}
                      tabs={fileTabs}
                    />
                  </div>
                )}
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
          className="absolute inset-y-2 left-0 z-30 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 focus-visible:after:bg-ring"
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
