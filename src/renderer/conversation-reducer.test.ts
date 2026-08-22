import { describe, expect, test } from 'vitest';
import { initialState, reduce } from '@/renderer/conversation-reducer';
import { CONTRACT_VERSION, type AgentEvent, type Conversation, type Entry } from '@/shared/agent-contract';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const ev = (seq: number, e: DistributiveOmit<AgentEvent, 'v' | 'seq' | 'conversationId'>): AgentEvent =>
  ({ v: CONTRACT_VERSION, seq, conversationId: 'c', ...e }) as AgentEvent;

const stubConversation: Conversation = {
  id: 'c', title: '', repoRoot: '/repo', createdAt: 0, updatedAt: 0, schemaVersion: 1,
};

const agentEntry: Entry = {
  id: 'e1', conversationId: 'c', author: 'agent', createdAt: 0, status: 'streaming', parts: [],
};

describe('conversation reducer', () => {
  test('entry.added appends the entry', () => {
    const s = reduce(initialState(), ev(1, { type: 'entry.added', entry: agentEntry }));
    expect(s.entries.map((e) => e.id)).toEqual(['e1']);
    expect(s.seq).toBe(1);
  });

  test('part.added then text.appended accumulate text', () => {
    let s = reduce(initialState(), ev(1, { type: 'entry.added', entry: agentEntry }));
    s = reduce(s, ev(2, { type: 'part.added', entryId: 'e1', index: 0, part: { id: 'p1', kind: 'text', text: '' } }));
    s = reduce(s, ev(3, { type: 'text.appended', entryId: 'e1', partId: 'p1', delta: 'Hel' }));
    s = reduce(s, ev(4, { type: 'text.appended', entryId: 'e1', partId: 'p1', delta: 'lo' }));
    const part = s.entries[0].parts[0];
    expect(part.kind === 'text' && part.text).toBe('Hello');
  });

  test('part.updated shallow-merges a work part patch', () => {
    let s = reduce(initialState(), ev(1, { type: 'entry.added', entry: agentEntry }));
    s = reduce(s, ev(2, { type: 'part.added', entryId: 'e1', index: 0, part: { id: 'w1', kind: 'file-read', path: 'a.ts', startedAt: 0, phase: 'running' } }));
    s = reduce(s, ev(3, { type: 'part.updated', entryId: 'e1', partId: 'w1', patch: { phase: 'done', endedAt: 5 } }));
    const part = s.entries[0].parts[0];
    expect(part.kind === 'file-read' && part.phase).toBe('done');
    expect(part.kind === 'file-read' && part.endedAt).toBe(5);
  });

  test('entry.status updates status', () => {
    let s = reduce(initialState(), ev(1, { type: 'entry.added', entry: agentEntry }));
    s = reduce(s, ev(2, { type: 'entry.status', entryId: 'e1', status: 'complete' }));
    expect(s.entries[0].status).toBe('complete');
  });

  test('a seq gap sets missedEvents', () => {
    let s = reduce(initialState(), ev(1, { type: 'entry.added', entry: agentEntry }));
    s = reduce(s, ev(3, { type: 'entry.status', entryId: 'e1', status: 'complete' })); // skipped 2
    expect(s.missedEvents).toBe(true);
  });

  test('reduce does not mutate the previous state', () => {
    const s0 = reduce(initialState(), ev(1, { type: 'entry.added', entry: agentEntry }));
    const before = JSON.stringify(s0);
    reduce(s0, ev(2, { type: 'entry.status', entryId: 'e1', status: 'complete' }));
    expect(JSON.stringify(s0)).toBe(before);
  });

  test('seeding from a snapshot at seq 0 still detects a gap on the next event', () => {
    const seeded = initialState({ conversation: stubConversation, entries: [], seq: 0 });
    const s = reduce(seeded, ev(2, { type: 'entry.status', entryId: 'e1', status: 'complete' })); // skipped 1
    expect(s.missedEvents).toBe(true);
  });

  test('seeding from a snapshot at seq 0 does not false-positive on seq 1', () => {
    const seeded = initialState({ conversation: stubConversation, entries: [], seq: 0 });
    const s = reduce(seeded, ev(1, { type: 'entry.status', entryId: 'e1', status: 'complete' }));
    expect(s.missedEvents).toBe(false);
  });
});
