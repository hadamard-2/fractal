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

  // One element, placed two ways. Execute puts it in its header row so it and
  // the sidebar trigger share a baseline structurally; the other modes have no
  // header yet, so they keep the fixed overlay — without it there would be no
  // way to switch back out of them.
  const modeToggle = <ModeToggle value={mode} onValueChange={setMode} />;

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <TitleBar />

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
            modeToggle={modeToggle}
            sidebarOpen={sidebarOpen}
            onSidebarOpenChange={setSidebarOpen}
          />
        ) : (
          <>
            {/*
              An invisible strip the same height as execute's header row, laid
              out the same way (`items-center`, `px-4`), so the toggle lands on
              exactly the same pixel in every mode and does not jump when the
              mode changes. Positioning it by a computed `top` offset instead
              would be the same drift problem the header row just removed.

              Fixed rather than in the content flow, so anything added to
              `main` later can't push it out of place; `z-50` matches the title
              bar. The strip ignores pointer events so it doesn't swallow
              clicks across the full width — only the toggle takes them back.
            */}
            <div
              className="pointer-events-none fixed inset-x-0 z-50 flex items-center justify-end px-4"
              style={{
                top: 'var(--titlebar-height)',
                height: 'var(--app-bar-height)',
              }}
            >
              <div className="pointer-events-auto">{modeToggle}</div>
            </div>
            <main className="flex flex-1 items-center justify-center" />
          </>
        )}
      </div>
    </div>
  );
}
