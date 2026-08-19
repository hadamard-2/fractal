import { useState } from 'react';

import { ModeToggle, type Mode } from '@/components/mode-toggle';
import { TitleBar } from '@/components/title-bar';

export default function App() {
  const [mode, setMode] = useState<Mode>('execute');

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <TitleBar />

      <div
        className="flex flex-col"
        style={{ paddingTop: 'env(titlebar-area-height, 2.25rem)' }}
      >
        <div className="flex justify-end px-3 pt-4 pb-2">
          <ModeToggle value={mode} onValueChange={setMode} />
        </div>

        <main className="flex flex-1 items-center justify-center" />
      </div>
    </div>
  );
}
