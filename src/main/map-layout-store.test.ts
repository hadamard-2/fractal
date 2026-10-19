import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { MapLayoutStore } from './map-layout-store';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir() { const dir = mkdtempSync(path.join(tmpdir(), 'fractal-map-layouts-')); dirs.push(dir); return dir; }

const first = { view: 'full' as const, nodes: { 'claude:b': { x: 1, y: 2, width: 400 } } };
const second = { view: 'preview' as const, nodes: {} };

test('keeps a layout per conversation across instances', () => {
  const dir = tempDir();
  const store = new MapLayoutStore(dir);
  expect(store.get('claude:a')).toBeUndefined();
  store.set('claude:a', first);
  store.set('codex:c', second);
  store.set('codex:c', { view: 'full', nodes: { 'codex:d': { x: -5, y: 6 } } });
  const reopened = new MapLayoutStore(dir);
  expect(reopened.get('claude:a')).toEqual(first);
  expect(reopened.get('codex:c')).toEqual({ view: 'full', nodes: { 'codex:d': { x: -5, y: 6 } } });
  expect(reopened.get('codex:missing')).toBeUndefined();
  expect(Object.keys(JSON.parse(readFileSync(path.join(dir, 'map-layouts.json'), 'utf8')).conversations)).toEqual(['claude:a', 'codex:c']);
});

test('reads a corrupt file as empty and replaces it on the next write', () => {
  const dir = tempDir();
  const file = path.join(dir, 'map-layouts.json');
  writeFileSync(file, '{ not json');
  const store = new MapLayoutStore(dir);
  expect(store.get('claude:a')).toBeUndefined();
  store.set('claude:a', first);
  expect(new MapLayoutStore(dir).get('claude:a')).toEqual(first);
});

test('drops an invalid entry and keeps its siblings', () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, 'map-layouts.json'), JSON.stringify({
    conversations: {
      'claude:a': first,
      'claude:b': { view: 'grid', nodes: {} },
      'claude:c': { view: 'full', nodes: { n: { x: 'far', y: 0 } } },
      'claude:d': 'full',
      'codex:e': second,
    },
  }));
  const store = new MapLayoutStore(dir);
  expect(store.get('claude:a')).toEqual(first);
  expect(store.get('claude:b')).toBeUndefined();
  expect(store.get('claude:c')).toBeUndefined();
  expect(store.get('claude:d')).toBeUndefined();
  expect(store.get('codex:e')).toEqual(second);
  writeFileSync(path.join(dir, 'map-layouts.json'), JSON.stringify([]));
  expect(store.get('claude:a')).toBeUndefined();
});
