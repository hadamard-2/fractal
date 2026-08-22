import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationStore } from '@/main/conversation-store';
import { createEchoAdapter } from '@/main/backend-adapter';
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
    expect(snap).not.toBeNull();
    expect(snap!.seq).toBeGreaterThan(0);
    expect(snap!.entries.length).toBeGreaterThanOrEqual(2); // user + agent
  });
});
