import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { CLAUDE_MODELS_ARGS, listClaudeModels, type ClaudeModelsProcess } from './claude-models';

type FakeProcess = ClaudeModelsProcess & EventEmitter & { stdout: PassThrough; stdin: PassThrough; signals: NodeJS.Signals[] };
function fakeProcess(): FakeProcess {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const signals: NodeJS.Signals[] = [];
  return Object.assign(emitter, {
    stdout, stdin, signals,
    kill(signal: NodeJS.Signals) { signals.push(signal); stdout.end(); return true; },
  }) as unknown as FakeProcess;
}
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const initialized = (models: unknown, requestId = 'fractal-models') => line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { commands: [], models } } });

describe('listClaudeModels', () => {
  test('asks a hook-free Claude for its models and reads them from the initialize response', async () => {
    const child = fakeProcess();
    const spawnProcess = vi.fn(() => child);
    const listing = listClaudeModels({ executable: '/usr/bin/claude', spawnProcess });
    expect(CLAUDE_MODELS_ARGS).toEqual(['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', '{"disableAllHooks":true}']);
    expect(spawnProcess).toHaveBeenCalledWith('/usr/bin/claude', CLAUDE_MODELS_ARGS);
    expect(JSON.parse(child.stdin.read().toString())).toEqual({ type: 'control_request', request_id: 'fractal-models', request: { subtype: 'initialize' } });
    child.stdout.write(line({ type: 'system', subtype: 'hook_started' }));
    child.stdout.write(initialized([{ value: 'ignored' }], 'someone-else'));
    child.stdout.write(initialized([
      { value: 'default', displayName: 'Default (recommended)', description: 'Sonnet 5', supportsEffort: true, supportedEffortLevels: ['low'] },
      { value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'high', 7] },
      { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5' },
      { value: 'fable', displayName: 'Fable', description: 'Most capable · Fable 5.1' },
      { value: 'sonnet', supportsEffort: false, supportedEffortLevels: ['low'] },
      { displayName: 'No value' },
    ]));
    await expect(listing).resolves.toEqual([
      { id: 'opus', label: 'Opus 5.5', description: 'Opus 5.5 · Best for everyday, complex tasks', efforts: ['low', 'high'] },
      { id: 'haiku', label: 'Haiku 4.5', description: 'Haiku 4.5', efforts: [] },
      { id: 'fable', label: 'Fable', description: 'Most capable · Fable 5.1', efforts: [] },
      { id: 'sonnet', label: 'sonnet', efforts: [] },
    ]);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  test('returns no models when the response has none', async () => {
    const child = fakeProcess();
    const listing = listClaudeModels({ spawnProcess: () => child });
    child.stdout.write(initialized(undefined));
    await expect(listing).resolves.toEqual([]);
  });

  test('returns no models on timeout and still kills the process', async () => {
    const child = fakeProcess();
    await expect(listClaudeModels({ spawnProcess: () => child, timeoutMs: 5 })).resolves.toEqual([]);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  test('returns no models when the process exits early or fails to launch', async () => {
    const exited = fakeProcess();
    const early = listClaudeModels({ spawnProcess: () => exited });
    exited.stdout.end();
    await expect(early).resolves.toEqual([]);
    const missing = fakeProcess();
    const failed = listClaudeModels({ spawnProcess: () => missing });
    missing.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    await expect(failed).resolves.toEqual([]);
  });
});
