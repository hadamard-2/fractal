import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type WatchSignal = 'SIGINT' | 'SIGTERM';

/**
 * Stops agent processes that would otherwise outlive Fractal.
 *
 * Fractal's own stop paths end its agents, but a crash, a force-quit or a
 * killed dev process skips them, and an agent left behind keeps working with
 * nobody watching. The watchdog is a separate process holding the read end of
 * a pipe from Fractal. The OS closes that pipe however Fractal ends, and at
 * that point the watchdog sends each watched process the signal it was
 * registered with, waits out a grace period, and SIGKILLs whatever is left.
 *
 * It is a POSIX shell script because Electron's run-as-Node mode is fused off
 * in packaged builds. It ignores INT, HUP and TERM, so a signal aimed at
 * Fractal's whole process group (Ctrl-C in a dev terminal) does not take it
 * down first; only the pipe closing ends it.
 */
export interface ProcessWatchdog {
  watch(pid: number, signal: WatchSignal): void;
  unwatch(pid: number): void;
}

const DEFAULT_GRACE_SECONDS = 5;

// Lines on stdin are "+ <pid> <INT|TERM>" or "- <pid>". Anything else, and
// any pid below 2, is ignored: `kill -1` and `kill 0` signal whole sets of
// processes, so they never reach `kill`, whatever arrives on the pipe.
const SCRIPT = `
trap '' INT HUP TERM
grace=$1
watched=''
while IFS=' ' read -r op pid sig; do
  case $pid in ''|*[!0-9]*) continue ;; esac
  [ "$pid" -gt 1 ] || continue
  case $op in
    +) case $sig in INT|TERM) watched="$watched $pid:$sig" ;; esac ;;
    -) kept=''
       for entry in $watched; do [ "\${entry%%:*}" = "$pid" ] || kept="$kept $entry"; done
       watched=$kept ;;
  esac
done
[ -n "$watched" ] || exit 0
for entry in $watched; do kill -s "\${entry#*:}" "\${entry%%:*}" 2>/dev/null; done
waited=0
while [ "$waited" -lt "$grace" ]; do
  running=''
  for entry in $watched; do kill -0 "\${entry%%:*}" 2>/dev/null && running=1; done
  [ -n "$running" ] || exit 0
  sleep 1
  waited=$((waited + 1))
done
for entry in $watched; do kill -s KILL "\${entry%%:*}" 2>/dev/null; done
`;

/** Starts the watchdog, or returns undefined on Windows, which has neither the script's shell nor its signals. */
export function startProcessWatchdog(options: {
  platform?: NodeJS.Platform;
  graceSeconds?: number;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
} = {}): ProcessWatchdog | undefined {
  if ((options.platform ?? process.platform) === 'win32') return undefined;
  const graceSeconds = options.graceSeconds ?? DEFAULT_GRACE_SECONDS;
  // detached: its own session, so terminal signals for Fractal's group never reach it.
  const child = (options.spawnProcess ?? spawn)('/bin/sh', ['-c', SCRIPT, 'fractal-watchdog', String(graceSeconds)], {
    detached: true, stdio: ['pipe', 'ignore', 'ignore'],
  });
  // A watchdog that failed to start, or died, must not take Fractal with it.
  child.once('error', () => undefined);
  child.stdin?.on('error', () => undefined);
  const send = (line: string): void => { if (child.stdin?.writable) child.stdin.write(`${line}\n`); };
  return {
    watch(pid, signal) {
      requireSingleProcess(pid);
      send(`+ ${pid} ${signal === 'SIGINT' ? 'INT' : 'TERM'}`);
    },
    unwatch(pid) {
      requireSingleProcess(pid);
      send(`- ${pid}`);
    },
  };
}

function requireSingleProcess(pid: number): void {
  if (!Number.isInteger(pid) || pid < 2) throw new Error(`Not a single process id: ${pid}`);
}
