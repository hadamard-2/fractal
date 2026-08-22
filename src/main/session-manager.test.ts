import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationStore } from '@/main/conversation-store';
import { createEchoAdapter } from '@/main/backend-adapter';
import type { BackendAdapter } from '@/main/backend-adapter';
import { SessionManager } from '@/main/session-manager';
import type { AgentEvent } from '@/shared/agent-contract';

let dir: string;
let store: ConversationStore;
let events: AgentEvent[];
let mgr: SessionManager;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fractal-sess-'));
  store = new ConversationStore(dir);
  events = [];
  mgr = new SessionManager({ store, adapter: createEchoAdapter(), emit: (e) => events.push(e) });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Polls until `check()` is true rather than sleeping a fixed duration. The
// echo adapter now paces its steps with real setTimeout delays (so a human
// can observe streaming), which means a fixed sleep has to guess a margin
// over that pacing — thin under CI contention, wasteful if padded generously.
// Polling waits for the actual condition instead, so it is fast when the
// adapter is fast and only as slow as it needs to be otherwise.
async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition not met within timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('SessionManager', () => {
  test('a turn emits a monotonic seq per conversation and settles the agent entry', async () => {
    const c = store.create('/repo');
    mgr.sendMessage({ conversationId: c.id, text: 'hi' });
    await waitUntil(() => events.some((e) => e.type === 'entry.status' && e.conversationId === c.id));

    const seqs = events.filter((e) => e.conversationId === c.id).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length); // strictly increasing, no repeats

    const status = events.filter((e) => e.type === 'entry.status');
    expect(status.at(-1)).toMatchObject({ status: 'complete' });

    // Settled agent entry was persisted.
    const reloaded = new ConversationStore(dir).load(c.id);
    const agentEntries = reloaded?.entries.filter((e) => e.author === 'agent') ?? [];
    expect(agentEntries).toHaveLength(1);
    expect(agentEntries[0].status).toBe('complete');
  });

  test('the user entry is persisted together with the agent entry, not before it settles', async () => {
    const blockedAdapter: BackendAdapter = {
      run() {
        return new Promise(() => {
          /* never resolves until the test cancels it */
        });
      },
    };
    const blockedEvents: AgentEvent[] = [];
    const blockedMgr = new SessionManager({ store, adapter: blockedAdapter, emit: (e) => blockedEvents.push(e) });

    const c = store.create('/repo');
    blockedMgr.sendMessage({ conversationId: c.id, text: 'hi' });
    await new Promise((r) => setTimeout(r, 0));

    // Live event went out immediately...
    expect(blockedEvents.some((e) => e.type === 'entry.added' && e.entry.author === 'user')).toBe(true);
    // ...but neither entry has been written to disk yet.
    const beforeSettle = new ConversationStore(dir).load(c.id);
    expect(beforeSettle?.entries ?? []).toHaveLength(0);

    blockedMgr.cancelTurn({ conversationId: c.id });
    await new Promise((r) => setTimeout(r, 0));

    const afterSettle = new ConversationStore(dir).load(c.id);
    expect(afterSettle?.entries.map((e) => e.author).sort()).toEqual(['agent', 'user']);
  });

  test('snapshot returns entries and the current seq', async () => {
    const c = store.create('/repo');
    mgr.sendMessage({ conversationId: c.id, text: 'hi' });
    await waitUntil(() => events.some((e) => e.type === 'entry.status' && e.conversationId === c.id));
    const snap = mgr.snapshot(c.id);
    if (!snap) throw new Error('expected a snapshot for a known conversation');
    expect(snap.seq).toBeGreaterThan(0);
    expect(snap.entries.length).toBeGreaterThanOrEqual(2); // user + agent
  });

  test('cancelTurn settles the agent entry exactly once, as interrupted', async () => {
    const c = store.create('/repo');
    mgr.sendMessage({ conversationId: c.id, text: 'hi' });
    mgr.cancelTurn({ conversationId: c.id });
    await new Promise((r) => setTimeout(r, 0)); // let the echo adapter's promise settle too

    const agentStatusEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: 'entry.status' }> =>
        e.type === 'entry.status' && e.conversationId === c.id,
    );
    // The echo adapter also resolves after cancellation; settle() must be
    // idempotent so only the first (cancelTurn's) status event goes out.
    expect(agentStatusEvents).toHaveLength(1);
    expect(agentStatusEvents[0].status).toBe('interrupted');

    const reloaded = new ConversationStore(dir).load(c.id);
    const agentEntries = reloaded?.entries.filter((e) => e.author === 'agent') ?? [];
    expect(agentEntries).toHaveLength(1);
    expect(agentEntries[0].status).toBe('interrupted');
  });

  test('an adapter that throws settles the entry exactly once as error, with the message surfaced', async () => {
    const failingAdapter: BackendAdapter = {
      async run() {
        throw new Error('adapter boom');
      },
    };
    const failEvents: AgentEvent[] = [];
    const failMgr = new SessionManager({ store, adapter: failingAdapter, emit: (e) => failEvents.push(e) });

    const c = store.create('/repo');
    failMgr.sendMessage({ conversationId: c.id, text: 'hi' });
    await new Promise((r) => setTimeout(r, 0));

    const agentStatusEvents = failEvents.filter(
      (e): e is Extract<AgentEvent, { type: 'entry.status' }> =>
        e.type === 'entry.status' && e.conversationId === c.id,
    );
    expect(agentStatusEvents).toHaveLength(1);
    expect(agentStatusEvents[0].status).toBe('error');
    expect(agentStatusEvents[0].error?.message).toBe('adapter boom');
  });

  test('requestPermission genuinely blocks the adapter until respondToPermission resolves it', async () => {
    let resumed = false;
    const gatedAdapter: BackendAdapter = {
      async run({ emit, requestPermission }) {
        const decision = await requestPermission('p1');
        resumed = true;
        emit({ kind: 'text', delta: decision.outcome === 'allow' ? 'allowed' : 'denied' });
      },
    };
    const gatedEvents: AgentEvent[] = [];
    const gatedMgr = new SessionManager({ store, adapter: gatedAdapter, emit: (e) => gatedEvents.push(e) });

    const c = store.create('/repo');
    gatedMgr.sendMessage({ conversationId: c.id, text: 'hi' });
    await new Promise((r) => setTimeout(r, 0));

    // Genuinely blocked: no text step has been emitted yet.
    expect(resumed).toBe(false);
    const textEventsBefore = gatedEvents.filter((e) => e.type === 'text.appended');
    expect(textEventsBefore).toHaveLength(0);

    const requested = gatedEvents.find(
      (e): e is Extract<AgentEvent, { type: 'permission.requested' }> => e.type === 'permission.requested',
    );
    if (!requested) throw new Error('expected a permission.requested event');

    gatedMgr.respondToPermission({ requestId: requested.requestId, decision: { outcome: 'allow' } });
    await new Promise((r) => setTimeout(r, 0));

    expect(resumed).toBe(true);
    const status = gatedEvents.filter((e) => e.type === 'entry.status');
    expect(status.at(-1)).toMatchObject({ status: 'complete' });
  });

  test('cancelTurn settles a pending permission promise instead of stranding it', async () => {
    let settledDecision: { outcome: string } | undefined;
    const gatedAdapter: BackendAdapter = {
      async run({ requestPermission }) {
        settledDecision = await requestPermission('p1');
      },
    };
    const gatedEvents: AgentEvent[] = [];
    const gatedMgr = new SessionManager({ store, adapter: gatedAdapter, emit: (e) => gatedEvents.push(e) });

    const c = store.create('/repo');
    gatedMgr.sendMessage({ conversationId: c.id, text: 'hi' });
    await new Promise((r) => setTimeout(r, 0));

    gatedMgr.cancelTurn({ conversationId: c.id });
    await new Promise((r) => setTimeout(r, 0));

    expect(settledDecision).toEqual({ outcome: 'deny', reason: 'Turn cancelled' });
    const resolved = gatedEvents.filter((e) => e.type === 'permission.resolved');
    expect(resolved).toHaveLength(1);
  });

  test('the emitted part.added event is a snapshot, not a live reference mutated by later deltas', async () => {
    const c = store.create('/repo');
    mgr.sendMessage({ conversationId: c.id, text: 'hi' });
    await waitUntil(() => events.some((e) => e.type === 'part.added' && e.conversationId === c.id));

    const partAdded = events.find(
      (e): e is Extract<AgentEvent, { type: 'part.added' }> =>
        e.type === 'part.added' && e.conversationId === c.id && e.part.kind === 'text',
    );
    if (!partAdded) throw new Error('expected a text part.added event');
    // Must still read as the initial (empty) text, not the accumulated final
    // text that the runtime kept appending to after this event was emitted.
    expect(partAdded.part.kind === 'text' && partAdded.part.text).toBe('');
  });
});
