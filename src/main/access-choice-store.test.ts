import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { AccessChoiceStore } from './access-choice-store';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir() { const dir = mkdtempSync(path.join(tmpdir(), 'fractal-access-choices-')); dirs.push(dir); return dir; }

test('keeps a pick per conversation across instances', () => {
  const dir = tempDir();
  const store = new AccessChoiceStore(dir);
  store.set('claude:a', { state: { kind: 'level', level: 'auto' }, sent: false });
  store.set('codex:b', { state: { kind: 'level', level: 'read-only' }, sent: true });
  const reopened = new AccessChoiceStore(dir);
  expect(reopened.get('claude:a')).toEqual({ state: { kind: 'level', level: 'auto' }, sent: false });
  expect(reopened.get('codex:b')).toEqual({ state: { kind: 'level', level: 'read-only' }, sent: true });
  expect(reopened.get('codex:missing')).toBeUndefined();
  expect(JSON.parse(readFileSync(path.join(dir, 'access-choices.json'), 'utf8'))).toEqual({
    conversations: {
      'claude:a': { state: { kind: 'level', level: 'auto' }, sent: false },
      'codex:b': { state: { kind: 'level', level: 'read-only' }, sent: true },
    },
  });
});

test('reads a corrupt file as empty and drops malformed entries', () => {
  const dir = tempDir();
  const file = path.join(dir, 'access-choices.json');
  writeFileSync(file, '{ not json');
  expect(new AccessChoiceStore(dir).get('claude:a')).toBeUndefined();
  writeFileSync(file, JSON.stringify({
    conversations: {
      'claude:a': { state: { kind: 'level', level: 'plan' }, sent: true },
      'claude:b': { state: { kind: 'level', level: '' }, sent: false },
      'claude:c': { state: { kind: 'level', level: 'plan' }, sent: 'yes' },
      'claude:d': { state: { kind: 'level', level: 'plan' } },
      'claude:e': 'plan',
      'claude:f': { state: { kind: 'other' }, sent: false },
    },
  }));
  const store = new AccessChoiceStore(dir);
  expect(store.get('claude:a')).toEqual({ state: { kind: 'level', level: 'plan' }, sent: true });
  for (const key of ['claude:b', 'claude:c', 'claude:d', 'claude:e', 'claude:f']) expect(store.get(key)).toBeUndefined();
  store.set('claude:g', { state: { kind: 'level', level: 'auto' }, sent: false });
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).conversations)).toEqual(['claude:a', 'claude:g']);
});
