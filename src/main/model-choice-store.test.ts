import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ModelChoiceStore } from './model-choice-store';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir() { const dir = mkdtempSync(path.join(tmpdir(), 'fractal-model-choices-')); dirs.push(dir); return dir; }

test('keeps a choice per conversation and the last choice per agent across instances', () => {
  const dir = tempDir();
  const store = new ModelChoiceStore(dir);
  store.set('claude:a', { model: 'opus', effort: 'high' });
  store.set('codex:b', { model: 'gpt-5.5' });
  store.setLastUsed('claude', { model: 'opus', effort: 'high' });
  const reopened = new ModelChoiceStore(dir);
  expect(reopened.get('claude:a')).toEqual({ model: 'opus', effort: 'high' });
  expect(reopened.get('codex:b')).toEqual({ model: 'gpt-5.5' });
  expect(reopened.get('codex:missing')).toBeUndefined();
  expect(reopened.lastUsed('claude')).toEqual({ model: 'opus', effort: 'high' });
  expect(reopened.lastUsed('codex')).toBeUndefined();
  expect(JSON.parse(readFileSync(path.join(dir, 'model-choices.json'), 'utf8'))).toEqual({
    conversations: { 'claude:a': { model: 'opus', effort: 'high' }, 'codex:b': { model: 'gpt-5.5' } },
    lastUsed: { claude: { model: 'opus', effort: 'high' } },
  });
});

test('clears the last choice for an agent', () => {
  const store = new ModelChoiceStore(tempDir());
  store.setLastUsed('codex', { model: 'gpt-5.5' });
  store.setLastUsed('codex', null);
  expect(store.lastUsed('codex')).toBeUndefined();
});

test('reads a corrupt file as empty and drops malformed entries', () => {
  const dir = tempDir();
  const file = path.join(dir, 'model-choices.json');
  writeFileSync(file, '{ not json');
  expect(new ModelChoiceStore(dir).get('claude:a')).toBeUndefined();
  writeFileSync(file, JSON.stringify({
    conversations: { 'claude:a': { model: 'opus' }, 'claude:b': { model: '' }, 'claude:c': 'opus', 'claude:d': { model: 'opus', effort: 4 } },
    lastUsed: { claude: { model: 'sonnet' }, gemini: { model: 'x' }, codex: null },
  }));
  const store = new ModelChoiceStore(dir);
  expect(store.get('claude:a')).toEqual({ model: 'opus' });
  expect(store.get('claude:b')).toBeUndefined();
  expect(store.get('claude:c')).toBeUndefined();
  expect(store.get('claude:d')).toBeUndefined();
  expect(store.lastUsed('claude')).toEqual({ model: 'sonnet' });
  expect(store.lastUsed('codex')).toBeUndefined();
});
