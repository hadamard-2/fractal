import { useState } from 'react';

import { ExecuteMode } from '@/components/execute-mode';
import { ModeToggle, type Mode } from '@/components/mode-toggle';
import { TitleBar } from '@/components/title-bar';

export default function App() {
  const [mode, setMode] = useState<Mode>('execute');

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
          <ExecuteMode modeToggle={modeToggle} />
        ) : (
          <>
            {/*
              A fixed overlay rather than part of the content flow, so anything
              added to `main` later can't push it out of place. `z-50` matches
              the title bar and keeps it painted above page content.
            */}
            <div
              className="fixed right-3 z-50"
              style={{ top: 'calc(var(--titlebar-height) + 1rem)' }}
            >
              {modeToggle}
            </div>
            <main className="flex flex-1 items-center justify-center" />
          </>
        )}
      </div>
    </div>
  );
}
