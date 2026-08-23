import { useState } from 'react';

import { ExecuteMode } from '@/components/execute-mode';
import { ModeToggle, type Mode } from '@/components/mode-toggle';
import { TitleBar } from '@/components/title-bar';

export default function App() {
  const [mode, setMode] = useState<Mode>('execute');
  // Held here, not inside ExecuteMode: leaving execute unmounts the whole
  // sidebar shell, so state owned down there would reset to open on every
  // return trip.
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <TitleBar />

      {/*
        Rendered once, outside the mode branch, and never moved. The sliding
        pill animates a transform, so it needs to survive the mode change to
        have something to animate from — rendering it per-mode unmounted and
        remounted it, and a fresh mount starts already at its final offset with
        no transition.

        The strip matches execute's header row: same height, same `items-center`
        and `px-4`, so the toggle sits on the same baseline as that row's
        sidebar trigger and title without either side computing an offset.
        Fixed rather than in the content flow, so nothing added to a mode's
        layout can push it around; `z-50` matches the title bar. It ignores
        pointer events so it doesn't swallow clicks across the full width —
        only the toggle takes them back.
      */}
      <div
        className="pointer-events-none fixed inset-x-0 z-50 flex items-center justify-end"
        style={{
          top: 'var(--titlebar-height)',
          height: 'var(--app-bar-height)',
          // Inset from the right by exactly what `items-center` leaves above
          // and below it, so the toggle sits the same distance from both edges
          // of its corner. Derived rather than typed as 8px so it tracks
          // --app-bar-height; 2.5rem is the toggle's own height (2rem items
          // plus its 0.25rem padding either side, see mode-toggle.tsx).
          paddingRight: 'calc((var(--app-bar-height) - 2.5rem) / 2)',
        }}
      >
        <div className="pointer-events-auto">
          <ModeToggle value={mode} onValueChange={setMode} />
        </div>
      </div>

      {/*
        Each mode owns its own layout below the title bar. Execute brings the
        sidebar shell; the others get a bare canvas until they grow one.
      */}
      <div
        className="flex h-full flex-col"
        style={{ paddingTop: 'var(--titlebar-height)' }}
      >
        {mode === 'execute' ? (
          <ExecuteMode
            sidebarOpen={sidebarOpen}
            onSidebarOpenChange={setSidebarOpen}
          />
        ) : (
          <main className="flex flex-1 items-center justify-center" />
        )}
      </div>
    </div>
  );
}
