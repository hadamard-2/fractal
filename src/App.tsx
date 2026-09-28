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
import { modeToggleShift } from '@/renderer/right-panel-layout';
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
        The corner strip: the mode toggle, then the right-panel toggle in the
        far-right corner. Rendered once, outside the mode branch, and never
        moved in the tree — the toggle's sliding pill animates a transform and
        needs to survive a mode change to have something to animate from.

        The strip matches execute's header row: same height, same
        `items-center`, riding the same offset below the title bar, so both
        toggles sit on that row's baseline. It ignores pointer events so it
        doesn't swallow clicks across the full width; only the controls take
        them back.

        The corner inset is (--app-bar-height − 2rem) / 2, the 2rem being the
        panel toggle's own size, so that toggle is as far from the window edge
        as from the band's top and bottom. That inset, the 4px `gap-1`, and
        the 32px toggle are what CLOSED_MODE_TOGGLE_RIGHT in
        right-panel-layout.ts adds up; change them together.

        While the panel is open, the mode toggle is translated left to sit just
        outside the panel's edge. A transform rather than a layout move, so it
        never remounts; index.css animates it on the panel's curve.
      */}
      <div
        className="pointer-events-none fixed inset-x-0 z-50 flex items-center justify-end gap-1"
        style={{
          top: 'calc(var(--titlebar-height) + var(--app-bar-offset))',
          height: 'var(--app-bar-height)',
          paddingRight: 'calc((var(--app-bar-height) - 2rem) / 2)',
        }}
      >
        {/* Hidden rather than unmounted, so the pill keeps its position to animate from. */}
        <div
          aria-hidden={onHomeScreen || undefined}
          className={onHomeScreen ? 'invisible' : 'pointer-events-auto'}
          data-slot="mode-toggle-shift"
          style={{ transform: `translateX(${-modeToggleShift(rightOpen, rightWidth ?? 0)}px)` }}
        >
          <ModeToggle value={mode} onValueChange={setMode} />
        </div>
        <Button
          aria-expanded={rightOpen}
          aria-label={rightOpen ? 'Close right panel' : 'Open right panel'}
          className="pointer-events-auto size-8"
          onClick={() => setRightOpen((open) => !open)}
          size="icon"
          variant="ghost"
        >
          <PanelRight aria-hidden className="size-4" />
        </Button>
      </div>

      {/*
        One shell frames every mode. Execute stays mounted (hidden) outside
        its own mode so a running session survives a mode switch.
      */}
      <div
        className="flex h-full flex-col"
        style={{ paddingTop: 'var(--titlebar-height)' }}
      >
        <RightWorkspace
          leftInsetRef={shellInsetRef}
          onOpenChange={setRightOpen}
          onResizingChange={setRightResizing}
          onWidthChange={setRightWidth}
          open={rightOpen}
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

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
