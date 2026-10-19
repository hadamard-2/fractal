import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { BranchStore, isSideChat, type BranchRecord } from './branch-store';

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

test('moves an unparseable file aside, reads as empty, and writes a fresh file without touching the moved one', () => {
  const dir = tempDir();
  const file = path.join(dir, 'branches.json');
  writeFileSync(file, '{ not json');
  const store = new BranchStore(dir);
  expect(store.get('claude:side')).toBeUndefined();
  expect(store.sideChatKeys()).toEqual(new Set());
  const moved = readdirSync(dir).filter((name) => name.startsWith('branches.json.corrupt-'));
  expect(moved).toHaveLength(1);
  expect(existsSync(file)).toBe(false);
  store.set('claude:side', sideChat);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ conversations: { 'claude:side': sideChat } });
  expect(readFileSync(path.join(dir, moved[0]), 'utf8')).toBe('{ not json');
});

test('moves aside a file that parses but is not a branch record', () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, 'branches.json'), '[1]');
  expect(new BranchStore(dir).sideChatKeys()).toEqual(new Set());
  expect(readdirSync(dir).some((name) => name.startsWith('branches.json.corrupt-'))).toBe(true);
});

test('throws on a read error other than a missing file, so callers fail closed', () => {
  const dir = tempDir();
  mkdirSync(path.join(dir, 'branches.json'));
  const store = new BranchStore(dir);
  expect(() => store.get('claude:side')).toThrow();
  expect(() => store.sideChatKeys()).toThrow();
  expect(() => store.set('claude:side', sideChat)).toThrow();
});

test('keeps its records in memory when the file becomes unreadable after loading', () => {
  const dir = tempDir();
  const file = path.join(dir, 'branches.json');
  const store = new BranchStore(dir);
  store.set('claude:side', sideChat);
  rmSync(file);
  mkdirSync(file);
  expect(store.get('claude:side')).toEqual(sideChat);
  expect(store.sideChatKeys()).toEqual(new Set(['claude:side']));
});

test('writes through, so a second set keeps the first record', () => {
  const dir = tempDir();
  const store = new BranchStore(dir);
  store.set('claude:side', sideChat);
  store.set('codex:fork', fork);
  expect(store.sideChatKeys()).toEqual(new Set(['claude:side']));
  expect(new BranchStore(dir).get('codex:fork')).toEqual(fork);
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

test('treats a conversation as a side chat when the store cannot be read', () => {
  const dir = tempDir();
  const store = new BranchStore(dir);
  store.set('claude:side', sideChat);
  store.set('codex:fork', fork);
  expect(isSideChat(store, 'claude:side')).toBe(true);
  expect(isSideChat(store, 'codex:fork')).toBe(false);
  expect(isSideChat(store, 'claude:missing')).toBe(false);
  const unreadable = tempDir();
  mkdirSync(path.join(unreadable, 'branches.json'));
  expect(isSideChat(new BranchStore(unreadable), 'claude:anything')).toBe(true);
});

test('delete removes one record, persists the removal and leaves its siblings', () => {
  const dir = tempDir();
  const store = new BranchStore(dir);
  store.set('claude:side', sideChat);
  store.set('codex:fork', fork);
  store.delete('claude:side');
  expect(store.get('claude:side')).toBeUndefined();
  expect(store.get('codex:fork')).toEqual(fork);
  const reopened = new BranchStore(dir);
  expect(reopened.get('claude:side')).toBeUndefined();
  expect(reopened.get('codex:fork')).toEqual(fork);
  expect(() => store.delete('claude:never-there')).not.toThrow();
});

test('lists the descendants at every depth, parents before children and oldest first among siblings', () => {
  const store = new BranchStore(tempDir());
  const child = (parentKey: string, createdAt: number, kind: BranchRecord['kind'] = 'side-chat'): BranchRecord => ({ ...sideChat, kind, parentKey, createdAt });
  store.set('claude:late', child('claude:root', 30));
  store.set('claude:grandchild', child('claude:early', 15, 'fork'));
  store.set('claude:early', child('claude:root', 10, 'fork'));
  store.set('claude:unrelated', child('claude:other', 5));
  store.set('claude:great', child('claude:grandchild', 50));
  expect(store.descendants('claude:root').map(([key]) => key)).toEqual(['claude:early', 'claude:late', 'claude:grandchild', 'claude:great']);
  expect(store.descendants('claude:root')[0]).toEqual(['claude:early', child('claude:root', 10, 'fork')]);
  expect(store.descendants('claude:none')).toEqual([]);
});

test('does not return a record whose parent was deleted', () => {
  const store = new BranchStore(tempDir());
  store.set('claude:a', { ...sideChat, parentKey: 'claude:root' });
  store.set('claude:b', { ...sideChat, parentKey: 'claude:a' });
  store.delete('claude:a');
  expect(store.descendants('claude:root')).toEqual([]);
});

test('returns each key at most once when parentKey forms a cycle', () => {
  const store = new BranchStore(tempDir());
  store.set('claude:root', { ...sideChat, parentKey: 'claude:b', createdAt: 1 });
  store.set('claude:a', { ...sideChat, parentKey: 'claude:root', createdAt: 2 });
  store.set('claude:b', { ...sideChat, parentKey: 'claude:a', createdAt: 3 });
  expect(store.descendants('claude:root').map(([key]) => key)).toEqual(['claude:a', 'claude:b']);
});

test('round-trips branchPointText and drops a non-string value while keeping the rest of the record', () => {
  const dir = tempDir();
  const withText: BranchRecord = { ...sideChat, branchPointText: 'The reply began like this' };
  new BranchStore(dir).set('claude:text', withText);
  expect(new BranchStore(dir).get('claude:text')).toEqual(withText);
  writeFileSync(path.join(dir, 'branches.json'), JSON.stringify({ conversations: { 'claude:bad': { ...sideChat, branchPointText: 7 } } }));
  expect(new BranchStore(dir).get('claude:bad')).toEqual(sideChat);
});

test('keeps the state before the latest write in branches.json.bak', () => {
  const dir = tempDir();
  const store = new BranchStore(dir);
  store.set('claude:side', sideChat);
  expect(existsSync(path.join(dir, 'branches.json.bak'))).toBe(false);
  store.set('codex:fork', fork);
  expect(JSON.parse(readFileSync(path.join(dir, 'branches.json.bak'), 'utf8'))).toEqual({ conversations: { 'claude:side': sideChat } });
});

test('does not back up a file that does not parse', () => {
  const dir = tempDir();
  const store = new BranchStore(dir);
  store.set('claude:side', sideChat);
  store.set('codex:fork', fork);
  writeFileSync(path.join(dir, 'branches.json'), '{ not json');
  store.set('claude:other', sideChat);
  expect(JSON.parse(readFileSync(path.join(dir, 'branches.json.bak'), 'utf8'))).toEqual({ conversations: { 'claude:side': sideChat } });
});

test('reads branches.json.bak when branches.json does not parse, after moving the bad file aside', () => {
  const dir = tempDir();
  const file = path.join(dir, 'branches.json');
  const backup = path.join(dir, 'branches.json.bak');
  const backedUp = JSON.stringify({ conversations: { 'claude:side': sideChat } });
  writeFileSync(file, '{ not json');
  writeFileSync(backup, backedUp);
  const store = new BranchStore(dir);
  expect(store.get('claude:side')).toEqual(sideChat);
  expect(isSideChat(store, 'claude:side')).toBe(true);
  expect(readdirSync(dir).filter((name) => name.startsWith('branches.json.corrupt-'))).toHaveLength(1);
  expect(readFileSync(backup, 'utf8')).toBe(backedUp);
});

test('writes the records recovered from the backup back, so a later launch still has them', () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, 'branches.json'), '{ not json');
  writeFileSync(path.join(dir, 'branches.json.bak'), JSON.stringify({ conversations: { 'claude:side': sideChat, 'codex:fork': fork } }));
  expect(new BranchStore(dir).get('claude:side')).toEqual(sideChat);
  expect(JSON.parse(readFileSync(path.join(dir, 'branches.json'), 'utf8'))).toEqual({ conversations: { 'claude:side': sideChat, 'codex:fork': fork } });
  const relaunched = new BranchStore(dir);
  expect(relaunched.get('codex:fork')).toEqual(fork);
  expect(isSideChat(relaunched, 'claude:side')).toBe(true);
  expect(readdirSync(dir).filter((name) => name.startsWith('branches.json.corrupt-'))).toHaveLength(1);
});

test('keeps the recovered records in memory when writing them back fails', () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, 'branches.json'), '{ not json');
  writeFileSync(path.join(dir, 'branches.json.bak'), JSON.stringify({ conversations: { 'claude:side': sideChat } }));
  mkdirSync(path.join(dir, 'branches.json.tmp'));
  const store = new BranchStore(dir);
  expect(store.get('claude:side')).toEqual(sideChat);
  expect(isSideChat(store, 'claude:side')).toBe(true);
});

test('reads as empty when both branches.json and its backup do not parse', () => {
  const dir = tempDir();
  writeFileSync(path.join(dir, 'branches.json'), '{ not json');
  writeFileSync(path.join(dir, 'branches.json.bak'), '[1]');
  const store = new BranchStore(dir);
  expect(store.sideChatKeys()).toEqual(new Set());
  expect(readdirSync(dir).filter((name) => name.startsWith('branches.json.corrupt-'))).toHaveLength(1);
});
