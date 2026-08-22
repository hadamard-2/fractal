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

describe('SessionManager', () => {
  test('a turn emits a monotonic seq per conversation and settles the agent entry', async () => {
    const c = store.create('/repo');
    mgr.sendMessage({ conversationId: c.id, text: 'hi' });
    await new Promise((r) => setTimeout(r, 0)); // let the async adapter drain

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

  test('snapshot returns entries and the current seq', async () => {
    const c = store.create('/repo');
    mgr.sendMessage({ conversationId: c.id, text: 'hi' });
    await new Promise((r) => setTimeout(r, 0));
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

  test('the emitted part.added event is a snapshot, not a live reference mutated by later deltas', async () => {
    const c = store.create('/repo');
    mgr.sendMessage({ conversationId: c.id, text: 'hi' });
    await new Promise((r) => setTimeout(r, 0));

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
