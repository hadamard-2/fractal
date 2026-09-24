import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SettingsStore } from './settings-store';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('persists sidebar order alongside theme and loads it on restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-'));
  dirs.push(dir);
  const store = new SettingsStore(dir);
  const sidebarOrder = { projects: ['/work/atlas', '/work/fractal'], chatsByProject: { '/work/fractal': ['codex:a', 'claude:b'] } };
  store.save({ theme: 'dark', sidebarOrder });
  expect(new SettingsStore(dir).load()).toEqual({ theme: 'dark', sidebarOrder });
});

test('keeps older settings files valid and filters malformed saved order', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-'));
  dirs.push(dir);
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ theme: 'light' }));
  expect(new SettingsStore(dir).load()).toEqual({ theme: 'light', sidebarOrder: { projects: [], chatsByProject: {} } });

  writeFileSync(file, JSON.stringify({ theme: 'light', sidebarOrder: { projects: ['/a', 4, '/a'], chatsByProject: { '/a': ['codex:x', null, 'codex:x'] } } }));
  expect(new SettingsStore(dir).load().sidebarOrder).toEqual({ projects: ['/a'], chatsByProject: { '/a': ['codex:x'] } });
  expect(JSON.parse(readFileSync(file, 'utf8')).sidebarOrder.projects).toEqual(['/a', 4, '/a']);
});
