import { useEffect, useRef, useState } from 'react';

import { PanelRight } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { ExecuteMode } from '@/components/execute-mode';
import { ExplainMode } from '@/components/explain-mode';
import { MapMode } from '@/components/map-mode';
import { MODE_ORDER, ModeToggle, type Mode } from '@/components/mode-toggle';
import { RightWorkspace } from '@/components/right-workspace';
import { SettingsDialog } from '@/components/settings-dialog';
import { TitleBar } from '@/components/title-bar';
import { Button } from '@/components/ui/button';
import { MODE_TOGGLE_INSET, modeToggleShift } from '@/renderer/right-panel-layout';
import { isAppShortcut } from '@/renderer/shortcuts';

export default function App() {
  const [mode, setMode] = useState<Mode>('execute');
  // Held here so the sidebar keeps its state across mode changes.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Chosen sidebar width in px; null means the 16rem default.
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  // Settings live at the app level, not in the sidebar: the dialog must be
  // reachable from every mode (Cmd+, works even where the sidebar — and thus
  // the footer button — isn't mounted), and stay mounted across mode changes.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Mirrored here for the sidebar, which never reloads settings itself; the
  // dialog reports changes back. Starts on, the stored default.
  const [showAgentColorTags, setShowAgentColorTags] = useState(true);
  // The right panel is app-level: one instance beside every mode, so its
  // tabs and shells survive mode changes. Width is null until first open.
  const [rightOpen, setRightOpen] = useState(false);
  const [rightWidth, setRightWidth] = useState<number | null>(null);
  const [rightResizing, setRightResizing] = useState(false);
  // Execute's selected project; new terminals start there in any mode.
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const shellInsetRef = useRef<HTMLElement>(null);
  // The home screen is Execute with nothing selected; the selected project is
  // null exactly then. The mode toggle stays out of it.
  const onHomeScreen = mode === 'execute' && projectPath === null;
  // The panel's tools all work inside a project, so without one it stays shut
  // and its toggle goes away. rightOpen is kept, so selecting a project again
  // brings the panel back as it was.
  const panelAvailable = projectPath !== null;
  const panelOpen = panelAvailable && rightOpen;

  useEffect(() => {
    let cancelled = false;
    window.fractal.settings
      .get()
      .then((settings) => {
        if (!cancelled) setShowAgentColorTags(settings.showAgentColorTags);
      })
      .catch(() => {
        // Keep the default rather than guess; the dialog shows the same failure.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cmd+, (Ctrl+, elsewhere) — the canonical application-settings shortcut.
  // Matched on `code` like main.ts's window shortcuts, so it survives
  // keyboard layouts where the comma sits behind a modifier. Mod+1–3 pick a
  // mode in the toggle's own left-to-right order.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Comma' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      const index = MODE_ORDER.findIndex((_, i) => isAppShortcut(event, `Digit${i + 1}`));
      if (index !== -1) {
        event.preventDefault();
        setMode(MODE_ORDER[index]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground" data-right-panel-resizing={rightResizing || undefined}>
      <TitleBar />

      {/*
        The right-panel toggle, at the app bar's right end. The 16px gap before
        the OS window controls leaves room enough that reaching for the toggle
        doesn't land on them; PANEL_TOGGLE_RIGHT in right-panel-layout.ts adds
        it up with the toggle's width, so change them together. The strip
        ignores pointer events so it doesn't swallow clicks across the bar;
        the toggle takes them back and opts out of the window's drag region.
      */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-40 flex items-center justify-end"
        style={{
          height: 'var(--app-bar-height)',
          paddingRight: 'calc(var(--window-controls-inset) + 16px)',
        }}
      >
        {panelAvailable && (
          <Button
            aria-expanded={panelOpen}
            aria-label={panelOpen ? 'Close right panel' : 'Open right panel'}
            className="pointer-events-auto size-7 app-region-no-drag"
            onClick={() => setRightOpen((open) => !open)}
            size="icon"
            variant="ghost"
          >
            <PanelRight aria-hidden className="size-4" />
          </Button>
        )}
      </div>

      {/*
        The mode toggle floats below the app bar, in the content area's
        top-right corner. Rendered once, outside the mode branch, and never
        moved in the tree — its sliding pill animates a transform and needs to
        survive a mode change to have something to animate from.

        It sits MODE_TOGGLE_INSET in from the content's right edge, and 13px
        below the bar, which centres its 40px on the line the sidebar's header
        and the right panel's tab row share (33px below the bar).

        While the panel is open, the toggle is translated left by the panel's
        width so it stays at the content's corner, beside the panel's edge. A
        transform rather than a layout move, so it never remounts; index.css
        animates it on the panel's curve. Hidden rather than unmounted on the
        home screen, so the pill keeps its position to animate from.
      */}
      <div
        aria-hidden={onHomeScreen || undefined}
        className={`fixed z-40 ${onHomeScreen ? 'invisible' : ''}`}
        data-slot="mode-toggle-shift"
        style={{
          top: 'calc(var(--app-bar-height) + 13px)',
          right: MODE_TOGGLE_INSET,
          transform: `translateX(${-modeToggleShift(panelOpen, rightWidth ?? 0)}px)`,
        }}
      >
        <ModeToggle value={mode} onValueChange={setMode} />
      </div>

      {/*
        One shell frames every mode. Execute stays mounted (hidden) outside
        its own mode so a running session survives a mode switch. It runs to
        the top of the window: the content's header is the app bar, and the
        sidebar and right panel each hang themselves below it.
      */}
      <div className="flex h-full flex-col">
        <RightWorkspace
          leftInsetRef={shellInsetRef}
          onOpenChange={setRightOpen}
          onResizingChange={setRightResizing}
          onWidthChange={setRightWidth}
          open={panelOpen}
          projectPath={projectPath}
          width={rightWidth}
        >
          <AppShell
            insetRef={shellInsetRef}
            onProjectPathChange={setProjectPath}
            sidebarOpen={sidebarOpen}
            onSidebarOpenChange={setSidebarOpen}
            sidebarWidth={sidebarWidth}
            onSidebarWidthChange={setSidebarWidth}
            onOpenSettings={() => setSettingsOpen(true)}
            showAgentColorTags={showAgentColorTags}
          >
            {(shell) => (
              <>
                <ExecuteMode active={mode === 'execute'} {...shell} />
                {mode === 'map' && <MapMode />}
                {mode === 'explain' && <ExplainMode />}
              </>
            )}
          </AppShell>
        </RightWorkspace>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} onShowAgentColorTagsChange={setShowAgentColorTags} />
    </div>
  );
}
