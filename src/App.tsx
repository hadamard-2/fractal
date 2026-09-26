import { useEffect, useRef, useState } from 'react';

import { PanelRight } from 'lucide-react';
import { ExecuteMode } from '@/components/execute-mode';
import { ModeToggle, type Mode } from '@/components/mode-toggle';
import { RightWorkspace } from '@/components/right-workspace';
import { SettingsDialog } from '@/components/settings-dialog';
import { TitleBar } from '@/components/title-bar';
import { Button } from '@/components/ui/button';
import { modeToggleShift } from '@/renderer/right-panel-layout';

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
  const executeInsetRef = useRef<HTMLElement>(null);

  // Cmd+, (Ctrl+, elsewhere) — the canonical application-settings shortcut.
  // Matched on `code` like main.ts's window shortcuts, so it survives
  // keyboard layouts where the comma sits behind a modifier.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Comma' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSettingsOpen(true);
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
        <div
          className="pointer-events-auto"
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
        Each mode owns its own layout below the title bar. Execute brings the
        sidebar shell; the others get a bare canvas until they grow one.
      */}
      <div
        className="flex h-full flex-col"
        style={{ paddingTop: 'var(--titlebar-height)' }}
      >
        <RightWorkspace
          leftInsetRef={mode === 'execute' ? executeInsetRef : undefined}
          onOpenChange={setRightOpen}
          onResizingChange={setRightResizing}
          onWidthChange={setRightWidth}
          open={rightOpen}
          projectPath={projectPath}
          width={rightWidth}
        >
          <ExecuteMode
            active={mode === 'execute'}
            insetRef={executeInsetRef}
            onProjectPathChange={setProjectPath}
            sidebarOpen={sidebarOpen}
            onSidebarOpenChange={setSidebarOpen}
            sidebarWidth={sidebarWidth}
            onSidebarWidthChange={setSidebarWidth}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          {mode !== 'execute' && <main className="flex flex-1 items-center justify-center" />}
        </RightWorkspace>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
