import { useState } from 'react';

import { ExecuteMode } from '@/components/execute-mode';
import { ModeToggle, type Mode } from '@/components/mode-toggle';
import { TitleBar } from '@/components/title-bar';

export default function App() {
  const [mode, setMode] = useState<Mode>('execute');

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <TitleBar />

      {/*
        The toggle is a fixed overlay, not part of the content flow, so
        anything added to `main` later can't push it out of place. `z-50`
        matches the title bar and keeps it painted above page content.
      */}
      <div
        className="fixed right-3 z-50"
        style={{ top: 'calc(var(--titlebar-height) + 1rem)' }}
      >
        <ModeToggle value={mode} onValueChange={setMode} />
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
          <ExecuteMode />
        ) : (
          <main className="flex flex-1 items-center justify-center" />
        )}
      </div>
    </div>
  );
}
