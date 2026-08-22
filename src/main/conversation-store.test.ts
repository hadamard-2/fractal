import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationStore } from '@/main/conversation-store';
import type { Entry } from '@/shared/agent-contract';

let dir: string;
let store: ConversationStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fractal-store-'));
  store = new ConversationStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (id: string): Entry => ({
  id,
  conversationId: 'x',
  author: 'agent',
  createdAt: 1,
  status: 'complete',
  parts: [{ id: 'p', kind: 'text', text: 'done' }],
});

describe('ConversationStore', () => {
  test('create stamps schemaVersion and repoRoot, and appears in list', () => {
    const c = store.create('/repo');
    expect(c.schemaVersion).toBe(1);
    expect(c.repoRoot).toBe('/repo');
    expect(store.list().map((x) => x.id)).toEqual([c.id]);
  });

  test('saveEntry persists and load round-trips', () => {
    const c = store.create('/repo');
    store.saveEntry(c.id, { ...entry('e1'), conversationId: c.id });
    const loaded = store.load(c.id);
    expect(loaded?.entries.map((e) => e.id)).toEqual(['e1']);
  });

  test('a fresh store instance reads what a prior instance wrote', () => {
    const c = store.create('/repo');
    store.saveEntry(c.id, { ...entry('e1'), conversationId: c.id });
    const reopened = new ConversationStore(dir);
    expect(reopened.load(c.id)?.entries).toHaveLength(1);
    expect(reopened.list()).toHaveLength(1);
  });

  test('load of unknown id is null', () => {
    expect(store.load('nope')).toBeNull();
  });

  test('refuses a conversation written by a newer contract version', () => {
    const c = store.create('/repo');
    // Simulate a future build having written this conversation.
    store.forceWriteRawForTest(c.id, { conversation: { ...c, schemaVersion: 99 }, entries: [] });
    expect(() => store.load(c.id)).toThrow(/newer version of Fractal/);
  });
});
