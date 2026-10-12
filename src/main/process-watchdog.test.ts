import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { startProcessWatchdog } from './process-watchdog';

// Real processes throughout: the watchdog is a shell script, and what it does
// to other processes is the whole contract.

let dir: string;
const targets: ChildProcess[] = [];
const watchdogs: ChildProcess[] = [];

beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'fractal-watchdog-')); });
afterEach(async () => {
  for (const child of [...targets, ...watchdogs]) {
    try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  targets.length = 0;
  watchdogs.length = 0;
  await rm(dir, { recursive: true, force: true });
});

/** A process that records the first INT or TERM it receives in `marker`, then exits; `ignoreInt` makes it shrug INT off. */
async function startTarget(name: string, options: { ignoreInt?: boolean } = {}): Promise<{ pid: number; marker: string; exited: Promise<void> }> {
  const marker = path.join(dir, name);
  const intTrap = options.ignoreInt ? `trap '' INT` : `trap 'echo INT > "$1"; exit 0' INT`;
  const child = spawn('/bin/sh', ['-c', `${intTrap}; trap 'echo TERM > "$1"; exit 0' TERM; echo ready > "$1"; while :; do sleep 0.1; done`, 'target', marker], {
    detached: true, stdio: 'ignore',
  });
  targets.push(child);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  for (let attempt = 0; attempt < 100 && await readMarker(marker) !== 'ready'; attempt++) await sleep(20);
  return { pid: pidOf(child), marker, exited };
}

/** Starts a watchdog whose child process the test keeps, so it can play Fractal dying by closing the pipe. */
function startWatchdog(graceSeconds = 1) {
  let child!: ChildProcess;
  const watchdog = startProcessWatchdog({
    platform: 'linux',
    graceSeconds,
    spawnProcess: (command, args, options) => { child = spawn(command, args, options); watchdogs.push(child); return child; },
  });
  if (!watchdog) throw new Error('expected a watchdog on linux');
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return { watchdog, child, exited, ownerDies: () => child.stdin?.end() };
}

async function readMarker(file: string): Promise<string> {
  try { return (await readFile(file, 'utf8')).trim(); } catch { return ''; }
}

function pidOf(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error('process did not start');
  return child.pid;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

describe('startProcessWatchdog', () => {
  test('sends each watched process the signal it was registered with once the owner goes away', async () => {
    const claude = await startTarget('claude');
    const codex = await startTarget('codex');
    const { watchdog, exited, ownerDies } = startWatchdog();
    watchdog.watch(claude.pid, 'SIGINT');
    watchdog.watch(codex.pid, 'SIGTERM');

    ownerDies();
    await exited;

    expect(await readMarker(claude.marker)).toBe('INT');
    expect(await readMarker(codex.marker)).toBe('TERM');
  });

  test('does nothing to a watched process while the owner is alive', async () => {
    const target = await startTarget('target');
    const { watchdog } = startWatchdog();
    watchdog.watch(target.pid, 'SIGINT');

    await sleep(300);

    expect(await readMarker(target.marker)).toBe('ready');
    expect(alive(target.pid)).toBe(true);
  });

  test('leaves a process alone after it is unwatched', async () => {
    const target = await startTarget('target');
    const { watchdog, exited, ownerDies } = startWatchdog();
    watchdog.watch(target.pid, 'SIGINT');
    watchdog.unwatch(target.pid);

    ownerDies();
    await exited;

    expect(await readMarker(target.marker)).toBe('ready');
    expect(alive(target.pid)).toBe(true);
  });

  test('force-kills a process that is still running when the grace period ends', async () => {
    const stubborn = await startTarget('stubborn', { ignoreInt: true });
    const { watchdog, exited, ownerDies } = startWatchdog(1);
    watchdog.watch(stubborn.pid, 'SIGINT');

    ownerDies();
    await exited;
    await Promise.race([stubborn.exited, sleep(1_000)]);

    expect(alive(stubborn.pid)).toBe(false);
    expect(await readMarker(stubborn.marker)).toBe('ready');
  });

  test('outlives an interrupt sent to its process group, as Ctrl-C in a dev terminal would', async () => {
    const target = await startTarget('target');
    const { watchdog, child, exited, ownerDies } = startWatchdog();
    watchdog.watch(target.pid, 'SIGINT');
    await sleep(200); // a Ctrl-C comes long after startup; before its first line, the shell has no traps yet

    process.kill(-pidOf(child), 'SIGINT');
    process.kill(-pidOf(child), 'SIGTERM');
    await sleep(200);
    ownerDies();
    await exited;

    expect(await readMarker(target.marker)).toBe('INT');
  });

  test('refuses process ids that would signal more than one process', () => {
    const { watchdog } = startWatchdog();
    for (const pid of [-1, 0, 1, 2.5, Number.NaN]) {
      expect(() => watchdog.watch(pid, 'SIGINT'), `pid ${pid}`).toThrow();
    }
  });

  test('is not started on Windows', () => {
    expect(startProcessWatchdog({ platform: 'win32' })).toBeUndefined();
  });
});
