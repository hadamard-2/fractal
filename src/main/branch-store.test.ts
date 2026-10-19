import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { BranchStore, type BranchRecord } from './branch-store';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir() { const dir = mkdtempSync(path.join(tmpdir(), 'fractal-branches-')); dirs.push(dir); return dir; }

const sideChat: BranchRecord = { kind: 'side-chat', parentKey: 'claude:main', afterTurnId: 'turn-3', inheritedTurnCount: 3, note: 'read only', createdAt: 100 };
const fork: BranchRecord = { kind: 'fork', parentKey: 'codex:main', afterTurnId: null, inheritedTurnCount: 0, createdAt: 200 };

test('keeps a record per conversation across instances in branches.json', () => {
  const dir = tempDir();
  const store = new BranchStore(dir);
  store.set('claude:side', sideChat);
  store.set('codex:fork', fork);
  const reopened = new BranchStore(dir);
  expect(reopened.get('claude:side')).toEqual(sideChat);
  expect(reopened.get('codex:fork')).toEqual(fork);
  expect(reopened.get('claude:missing')).toBeUndefined();
  expect(JSON.parse(readFileSync(path.join(dir, 'branches.json'), 'utf8'))).toEqual({
    conversations: { 'claude:side': sideChat, 'codex:fork': fork },
  });
});

test('lists only side chat keys', () => {
  const store = new BranchStore(tempDir());
  store.set('claude:side', sideChat);
  store.set('codex:fork', fork);
  expect(store.sideChatKeys()).toEqual(new Set(['claude:side']));
});

test('reads an unparseable file as empty and replaces it on the next write', () => {
  const dir = tempDir();
  const file = path.join(dir, 'branches.json');
  writeFileSync(file, '{ not json');
  const store = new BranchStore(dir);
  expect(store.get('claude:side')).toBeUndefined();
  expect(store.sideChatKeys()).toEqual(new Set());
  store.set('claude:side', sideChat);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ conversations: { 'claude:side': sideChat } });
});

test('drops malformed entries and keeps valid siblings', () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, 'branches.json'), JSON.stringify({
    conversations: {
      'claude:ok': sideChat,
      'claude:kind': { ...sideChat, kind: 'branch' },
      'claude:count': { ...sideChat, inheritedTurnCount: -1 },
      'claude:parent': { ...sideChat, parentKey: 7 },
      'claude:turn': { ...sideChat, afterTurnId: 7 },
      'claude:created': { ...sideChat, createdAt: 'now' },
      'claude:note': { ...sideChat, note: 7 },
      'claude:string': 'side-chat',
    },
  }));
  const store = new BranchStore(dir);
  expect(store.get('claude:ok')).toEqual(sideChat);
  for (const key of ['claude:kind', 'claude:count', 'claude:parent', 'claude:turn', 'claude:created', 'claude:note', 'claude:string']) {
    expect(store.get(key)).toBeUndefined();
  }
  expect(store.sideChatKeys()).toEqual(new Set(['claude:ok']));
});
