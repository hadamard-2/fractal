import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SettingsStore } from './settings-store';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('persists the coding agent alongside theme and sidebar order', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-'));
  dirs.push(dir);
  const store = new SettingsStore(dir);
  const sidebarOrder = { projects: ['/work/atlas', '/work/fractal'], chatsByProject: { '/work/fractal': ['codex:a', 'claude:b'] } };
  store.save({ theme: 'dark', defaultCodingAgent: 'ask', sidebarOrder, projectVisibility: { archived: [], removed: [] }, projectFilter: 'active' });
  expect(new SettingsStore(dir).load()).toEqual({ theme: 'dark', defaultCodingAgent: 'ask', sidebarOrder, projectVisibility: { archived: [], removed: [] }, projectFilter: 'active' });
});

test('keeps older settings files valid and filters malformed saved order', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-'));
  dirs.push(dir);
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ theme: 'light' }));
  expect(new SettingsStore(dir).load()).toEqual({ theme: 'light', defaultCodingAgent: 'claude', sidebarOrder: { projects: [], chatsByProject: {} }, projectVisibility: { archived: [], removed: [] }, projectFilter: 'active' });

  writeFileSync(file, JSON.stringify({ theme: 'light', sidebarOrder: { projects: ['/a', 4, '/a'], chatsByProject: { '/a': ['codex:x', null, 'codex:x'] } } }));
  expect(new SettingsStore(dir).load().sidebarOrder).toEqual({ projects: ['/a'], chatsByProject: { '/a': ['codex:x'] } });
  expect(JSON.parse(readFileSync(file, 'utf8')).sidebarOrder.projects).toEqual(['/a', 4, '/a']);

  writeFileSync(file, JSON.stringify({ theme: 'light', defaultCodingAgent: 'unknown' }));
  expect(new SettingsStore(dir).load().defaultCodingAgent).toBe('claude');
});

test('persists project visibility and the sidebar filter, and repairs malformed values', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-'));
  dirs.push(dir);
  const file = path.join(dir, 'settings.json');
  const store = new SettingsStore(dir);
  const projectVisibility = { archived: ['/work/old'], removed: ['/work/gone'] };
  store.save({ ...store.load(), projectVisibility, projectFilter: 'all' });
  expect(new SettingsStore(dir).load()).toMatchObject({ projectVisibility, projectFilter: 'all' });

  writeFileSync(file, JSON.stringify({ theme: 'light' }));
  expect(new SettingsStore(dir).load()).toMatchObject({ projectVisibility: { archived: [], removed: [] }, projectFilter: 'active' });

  // A path in both lists is removed: removal is the stronger state.
  writeFileSync(file, JSON.stringify({ projectVisibility: { archived: ['/a', 3, '/b', '/a'], removed: ['/b', null] }, projectFilter: 'sometimes' }));
  expect(new SettingsStore(dir).load()).toMatchObject({ projectVisibility: { archived: ['/a'], removed: ['/b'] }, projectFilter: 'active' });
});
