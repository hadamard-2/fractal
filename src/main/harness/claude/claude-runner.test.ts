import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import type { NativeEvent } from '@/main/harness/reconciler';
import { runClaudeTurn, type ClaudeChildProcess } from './claude-runner';

const ref = { provider: 'claude' as const, nativeSessionId: 'claude-session-1', projectPath: '/work/fractal' };
const bridge = { configPath: '/tmp/bridge.json', toolName: 'fractal_permission' };

function fakeProcess(): ClaudeChildProcess & { stdout: PassThrough; stderr: PassThrough; finish(code?: number): void; signals: NodeJS.Signals[] } {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signals: NodeJS.Signals[] = [];
  return Object.assign(emitter, {
    stdout, stderr, signals, pid: 123,
    kill(signal: NodeJS.Signals) { signals.push(signal); return true; },
    finish(code = 0) { stdout.end(); stderr.end(); emitter.emit('close', code, null); },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of iterable) values.push(value); return values; }

describe('runClaudeTurn', () => {
  test('spawns resume as an exact argument array without a shell', async () => {
    const child = fakeProcess();
    const spawnProcess = vi.fn(() => child);
    const run = runClaudeTurn({ ref, prompt: { text: 'fix; $(touch /tmp/nope)' }, executable: '/usr/bin/claude', spawnProcess, permissionBridge: bridge, rereadNative: async () => [] });
    child.finish(); await collect(run.events);
    expect(spawnProcess).toHaveBeenCalledWith('/usr/bin/claude', [
      '--resume', 'claude-session-1', '--print', 'fix; $(touch /tmp/nope)', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--mcp-config', '/tmp/bridge.json', '--permission-prompt-tool', 'fractal_permission',
    ], { cwd: '/work/fractal', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  });

  test('uses session-id for the first turn', async () => {
    const child = fakeProcess(); const spawnProcess = vi.fn(() => child);
    const run = runClaudeTurn({ ref, prompt: { text: 'begin' }, executable: 'claude', spawnProcess, permissionBridge: bridge, newSession: true, rereadNative: async () => [] });
    child.finish(); await collect(run.events);
    const call = spawnProcess.mock.calls[0] as unknown as [string, string[]];
    expect(call[1].slice(0, 2)).toEqual(['--session-id', 'claude-session-1']);
  });

  test('normalizes parsable stdout and reconciles native history even after a nonzero exit', async () => {
    const child = fakeProcess();
    const reconciled: NativeEvent = { provider: 'claude', nativeId: 'file-result', nativeType: 'result', observedAt: 3, payload: { kind: 'turn-finished', turnId: 'user-1', status: 'failed' } };
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess: () => child, permissionBridge: bridge, rereadNative: async () => [reconciled] });
    child.stderr.write('token=secret\u0000 bad\n');
    child.stdout.write('{"type":"user","uuid":"user-1","message":{"role":"user","content":"go"}}\n');
    child.finish(1);
    const events = await collect(run.events);
    expect(events.some((event) => event.payload.kind === 'turn-started')).toBe(true);
    expect(events.at(-1)).toEqual(reconciled);
    await expect(run.completion).resolves.toMatchObject({ exitCode: 1, diagnostic: expect.not.stringContaining('\u0000') });
  });

  test('interrupt signals only its owned child with SIGINT then SIGTERM after two seconds', async () => {
    vi.useFakeTimers();
    const child = fakeProcess();
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess: () => child, permissionBridge: bridge, rereadNative: async () => [] });
    const interrupted = run.interrupt();
    expect(child.signals).toEqual(['SIGINT']);
    await vi.advanceTimersByTimeAsync(1_999); expect(child.signals).toEqual(['SIGINT']);
    await vi.advanceTimersByTimeAsync(1); expect(child.signals).toEqual(['SIGINT', 'SIGTERM']);
    child.finish(); await interrupted; await collect(run.events);
    vi.useRealTimers();
  });
});
