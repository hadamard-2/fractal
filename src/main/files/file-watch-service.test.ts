import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { FilesEvent } from '@/shared/files-contract';
import { FileWatchService, type DirectoryWatcher } from './file-watch-service';
import { OutsideProjectError } from './project-paths';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fractal-watch-')));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'a');
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

function fakeWatcher() {
  const watched: Array<{ directory: string; onChange: (name: string | null) => void; closed: boolean }> = [];
  const factory: DirectoryWatcher = (directory: string, onChange: (name: string | null) => void): { close(): void } => {
    const entry = { directory, onChange, closed: false };
    watched.push(entry);
    return { close: () => { entry.closed = true; } };
  };
  return { watched, factory };
}
const noop = (): void => undefined;

test('watches a folder directly and a file through its folder, filtered to its name and debounced', async () => {
  const f = fakeWatcher();
  const service = new FileWatchService(f.factory, 100);
  const events: FilesEvent[] = [];
  await service.watch({}, 'dir', root, 'src', (event) => events.push(event));
  await service.watch({}, 'file', root, 'src/a.ts', (event) => events.push(event));
  expect(f.watched.map((entry) => entry.directory)).toEqual([join(root, 'src'), join(root, 'src')]);
  vi.useFakeTimers();
  f.watched[1].onChange('b.ts');
  vi.advanceTimersByTime(100);
  expect(events).toEqual([]);
  f.watched[1].onChange('a.ts');
  f.watched[1].onChange('a.ts');
  vi.advanceTimersByTime(99);
  expect(events).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(events).toEqual([{ type: 'changed', watchId: 'file' }]);
  f.watched[0].onChange('anything');
  f.watched[1].onChange(null);
  vi.advanceTimersByTime(100);
  expect(events).toEqual([{ type: 'changed', watchId: 'file' }, { type: 'changed', watchId: 'dir' }, { type: 'changed', watchId: 'file' }]);
});

test('watches a missing file through its folder, so its return is noticed', async () => {
  const f = fakeWatcher();
  const service = new FileWatchService(f.factory, 0);
  const events: FilesEvent[] = [];
  await service.watch({}, 'new', root, 'src/new.ts', (event) => events.push(event));
  expect(f.watched[0].directory).toBe(join(root, 'src'));
  f.watched[0].onChange('new.ts');
  await vi.waitFor(() => expect(events).toEqual([{ type: 'changed', watchId: 'new' }]));
});

test('keeps watches per owner and closes them all with their owner', async () => {
  const f = fakeWatcher();
  const service = new FileWatchService(f.factory, 0);
  const owner = {};
  await service.watch(owner, 'one', root, 'src', noop);
  await expect(service.watch(owner, 'one', root, 'src', noop)).rejects.toThrow('Watch already exists');
  expect(() => service.unwatch({}, 'one')).toThrow('Watch belongs to another owner');
  await service.watch(owner, 'two', root, '', noop);
  service.closeOwner(owner);
  expect(f.watched.every((entry) => entry.closed)).toBe(true);
  expect(() => service.unwatch(owner, 'one')).not.toThrow();
});

test('an unwatch during setup leaves nothing running', async () => {
  const f = fakeWatcher();
  const service = new FileWatchService(f.factory, 0);
  const owner = {};
  const pending = service.watch(owner, 'one', root, 'src', noop);
  service.unwatch(owner, 'one');
  await pending;
  expect(f.watched).toEqual([]);
});

test('refuses paths outside the project', async () => {
  const service = new FileWatchService(fakeWatcher().factory, 0);
  await expect(service.watch({}, 'x', root, '../x', noop)).rejects.toBeInstanceOf(OutsideProjectError);
});

test('reports a temp-file-and-rename save through a real folder watch', async () => {
  const service = new FileWatchService(undefined, 20);
  const events: FilesEvent[] = [];
  await service.watch({}, 'file', root, 'src/a.ts', (event) => events.push(event));
  await writeFile(join(root, 'src', '.a.ts.tmp'), 'new');
  await rename(join(root, 'src', '.a.ts.tmp'), join(root, 'src', 'a.ts'));
  await vi.waitFor(() => expect(events).toContainEqual({ type: 'changed', watchId: 'file' }));
  service.dispose();
});
