import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Button } from '@/components/ui/button';

export function TerminalView({ id, cwd, visible, focusToken = 0, onShellReady, onExitedChange }: {
  id: string;
  cwd: string | null;
  visible: boolean;
  // Bumped by the panel to ask for keyboard focus; each value is honoured once.
  focusToken?: number;
  onShellReady: (started: { shell: string; cwd: string }) => void;
  onExitedChange?: (exited: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  const onShellReadyRef = useRef(onShellReady);
  const onExitedChangeRef = useRef(onExitedChange);
  onExitedChangeRef.current = onExitedChange;
  const terminalRef = useRef<Terminal | null>(null);
  const handledFocus = useRef(0);
  const fitRef = useRef<(() => void) | null>(null);
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<'starting' | 'running' | 'exited' | 'error'>('starting');
  const [exitCode, setExitCode] = useState<number | null>(null);
  visibleRef.current = visible;
  onShellReadyRef.current = onShellReady;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let started = false;
    let exited = false;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
      fontSize: 13,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;

    const applyTheme = () => {
      const style = getComputedStyle(host);
      terminal.options.theme = {
        background: style.getPropertyValue('--background').trim() || '#0a0a0a',
        foreground: style.getPropertyValue('--foreground').trim() || '#fafafa',
      };
    };
    applyTheme();
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onThemeChange = () => { requestAnimationFrame(applyTheme); };
    media?.addEventListener('change', onThemeChange);

    const fitNow = () => {
      if (!visibleRef.current || disposed) return;
      const bounds = host.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      fit.fit();
      if (started && terminal.cols > 0 && terminal.rows > 0) {
        void window.fractal.terminals.resize(id, terminal.cols, terminal.rows).catch((): void => undefined);
      }
    };
    fitRef.current = fitNow;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitNow);
    observer?.observe(host);
    const off = window.fractal.terminals.onEvent((event) => {
      if (event.id !== id || disposed) return;
      if (event.type === 'data') terminal.write(event.data);
      else {
        exited = true;
        setExitCode(event.exitCode);
        setState('exited');
      }
    });
    const input = terminal.onData((data) => {
      if (started && !exited) void window.fractal.terminals.write(id, data).catch((): void => undefined);
    });

    setState('starting');
    setExitCode(null);
    const creating = window.fractal.terminals.create({ id, cwd: cwd ?? undefined, cols: 80, rows: 24 });
    void creating.then(({ shell, cwd: startedIn }) => {
      if (disposed) { void window.fractal.terminals.close(id).catch((): void => undefined); return; }
      started = true;
      onShellReadyRef.current({ shell, cwd: startedIn });
      if (!exited) setState('running');
      fitNow();
    }).catch(() => { if (!disposed) setState('error'); });
    fitNow();

    return () => {
      disposed = true;
      fitRef.current = null;
      terminalRef.current = null;
      observer?.disconnect();
      media?.removeEventListener('change', onThemeChange);
      off();
      input.dispose();
      terminal.dispose();
      if (started) void window.fractal.terminals.close(id).catch((): void => undefined);
    };
  }, [id, cwd, generation]);

  useEffect(() => { if (visible) fitRef.current?.(); }, [visible]);

  useEffect(() => { onExitedChangeRef.current?.(state === 'exited'); }, [state]);

  // Declared after the main effect so, on a tab's first mount, the terminal
  // exists by the time a focus request is honoured.
  useEffect(() => {
    if (!visible || focusToken === handledFocus.current) return;
    handledFocus.current = focusToken;
    terminalRef.current?.focus();
  }, [focusToken, visible]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-hidden p-2">
        <div aria-label="Terminal" className="h-full w-full" data-slot="terminal" ref={hostRef} />
      </div>
      {state === 'exited' && <div className="absolute inset-x-3 bottom-3 flex items-center justify-between rounded-md border bg-background px-3 py-2 text-xs" role="status"><span>Shell exited with code {exitCode}.</span><Button aria-label="Restart terminal" onClick={() => setGeneration((value) => value + 1)} size="xs" variant="outline">Restart</Button></div>}
      {state === 'error' && <div className="absolute inset-x-3 bottom-3 flex items-center justify-between rounded-md border bg-background px-3 py-2 text-xs" role="status"><span>Terminal could not start.</span><Button aria-label="Retry terminal" onClick={() => setGeneration((value) => value + 1)} size="xs" variant="outline">Retry</Button></div>}
    </div>
  );
}
