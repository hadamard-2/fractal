import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { detectEditors, EDITORS, openWith, type DetectedEditor, type Spawn } from './editors';

const zed: DetectedEditor = { id: 'zed', label: 'Zed', executable: '/bin/zed' };
const shell = () => ({ openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() });
function spawned(event: 'spawn' | 'error') {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const spawnProcess = vi.fn(() => { queueMicrotask(() => child.emit(event, new Error('no'))); return child; });
  return { child, spawnProcess: spawnProcess as unknown as Spawn & typeof spawnProcess };
}

test('builds each editor\'s arguments with and without a line', () => {
  expect(EDITORS.vscode.args('/repo', '/repo/a.ts', 12)).toEqual(['/repo', '-g', '/repo/a.ts:12']);
  expect(EDITORS.cursor.args('/repo', '/repo/a.ts')).toEqual(['/repo', '-g', '/repo/a.ts']);
  expect(EDITORS.zed.args('/repo', '/repo/a.ts', 3)).toEqual(['/repo/a.ts:3']);
  expect(EDITORS.sublime.args('/repo', '/repo/a.ts')).toEqual(['/repo/a.ts']);
});

test('detects editors on the search path in menu order, and none on Windows', async () => {
  const present = new Set(['/home/me/.local/bin/zed', '/usr/bin/code', '/opt/code']);
  const isExecutable = async (file: string) => present.has(file);
  expect(await detectEditors('linux', '/usr/bin:/home/me/.local/bin:/opt', isExecutable)).toEqual([
    { id: 'vscode', label: 'VS Code', executable: '/usr/bin/code' },
    { id: 'zed', label: 'Zed', executable: '/home/me/.local/bin/zed' },
  ]);
  expect(await detectEditors('darwin', '/usr/bin', isExecutable)).toHaveLength(1);
  expect(await detectEditors('win32', '/usr/bin', isExecutable)).toEqual([]);
});

test('starts a detected editor detached, with no shell, and lets it outlive Fractal', async () => {
  const { child, spawnProcess } = spawned('spawn');
  const result = await openWith('zed', { root: '/repo', file: '/repo/a.ts', line: 4 }, { editors: async () => [zed], shell: shell(), spawnProcess });
  expect(result).toEqual({ ok: true });
  expect(spawnProcess).toHaveBeenCalledWith('/bin/zed', ['/repo/a.ts:4'], { detached: true, stdio: 'ignore', shell: false });
  expect(child.unref).toHaveBeenCalled();
});

test('reports an editor that is not detected or fails to start', async () => {
  const { spawnProcess } = spawned('error');
  expect(await openWith('zed', { root: '/repo', file: '/repo/a.ts' }, { editors: async () => [zed], shell: shell(), spawnProcess })).toEqual({ ok: false, message: 'Couldn\'t start Zed' });
  expect(await openWith('vscode', { root: '/repo', file: '/repo/a.ts' }, { editors: async () => [zed], shell: shell(), spawnProcess })).toEqual({ ok: false, message: 'VS Code isn\'t available' });
});

test('opens with the default app or shows the file in its folder', async () => {
  const s = shell();
  expect(await openWith('system', { root: '/repo', file: '/repo/a.ts' }, { editors: async () => [], shell: s })).toEqual({ ok: true });
  expect(s.openPath).toHaveBeenCalledWith('/repo/a.ts');
  s.openPath.mockResolvedValue('No application is registered');
  expect(await openWith('system', { root: '/repo', file: '/repo/a.ts' }, { editors: async () => [], shell: s })).toEqual({ ok: false, message: 'Couldn\'t open this file with the default app' });
  expect(await openWith('reveal', { root: '/repo', file: '/repo/a.ts' }, { editors: async () => [], shell: s })).toEqual({ ok: true });
  expect(s.showItemInFolder).toHaveBeenCalledWith('/repo/a.ts');
});
