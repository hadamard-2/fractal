import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { ClaudeAdapter } from '@/main/harness/claude/claude-adapter';
import { defaultClaudeExec, probeClaude } from '@/main/harness/claude/claude-probe';
import { CodexAdapter } from '@/main/harness/codex/codex-adapter';
import { CodexAppServer, codexSpawner } from '@/main/harness/codex/codex-app-server';
import type { HarnessAdapter } from '@/main/harness/types';
import { TurnProjector } from '@/main/harness/turn-projector';
import { conversationKey, type ConversationRef, type ProviderId } from '@/shared/conversation-contract';

vi.mock('electron', () => ({ app: { getVersion: () => 'integration-test' } }));

/**
 * Drives the real adapters against the installed agents. Forking and deleting spend no model turns, but they
 * do create and remove a real session in the agent's own history, so this only runs when asked for:
 *
 *   FRACTAL_REAL_CLI=1 FRACTAL_PROBE_PROVIDER=claude|codex FRACTAL_PROBE_SESSION=<id> FRACTAL_PROBE_PROJECT=<path> \
 *     pnpm vitest run src/main/real-cli.integration.test.ts
 *
 * The source conversation must have at least two turns.
 */
const enabled = process.env.FRACTAL_REAL_CLI === '1';

async function loadTurnIds(adapter: HarnessAdapter, ref: ConversationRef): Promise<string[]> {
  const loaded = await adapter.loadConversation(ref);
  const projector = new TurnProjector();
  const ids: string[] = [];
  const take = (updates: ReturnType<TurnProjector['push']>): void => {
    for (const update of updates) if (update.finalized && !ids.includes(update.turn.id)) ids.push(update.turn.id);
  };
  for await (const event of loaded.events) take(projector.push(event));
  take(projector.finish());
  return ids;
}

describe.skipIf(!enabled)('real agent fork and delete', () => {
  let adapter: HarnessAdapter;
  let server: CodexAppServer | undefined;
  const provider = process.env.FRACTAL_PROBE_PROVIDER as ProviderId | undefined;
  const sessionId = process.env.FRACTAL_PROBE_SESSION;
  const project = process.env.FRACTAL_PROBE_PROJECT;

  beforeAll(async () => {
    if (provider !== 'claude' && provider !== 'codex') throw new Error('FRACTAL_PROBE_PROVIDER must be claude or codex');
    if (!sessionId || !project) throw new Error('FRACTAL_PROBE_SESSION and FRACTAL_PROBE_PROJECT are required');
    const canonicalPath = async (input: string) => realpath(input).catch(() => input);
    if (provider === 'codex') {
      server = await CodexAppServer.start(codexSpawner('codex'), new AbortController().signal);
      adapter = new CodexAdapter(server, { realpath: canonicalPath });
    } else {
      adapter = new ClaudeAdapter(path.join(homedir(), '.claude', 'projects'), { realpath: canonicalPath, probe: () => probeClaude(defaultClaudeExec, 'claude') });
    }
    expect((await adapter.probe()).availability).toBe('available');
  });

  afterAll(async () => { await server?.dispose(); });

  test('forks a read-only side chat after the second turn, which holds exactly those two turns, and deletes it', async () => {
    if (!provider || !sessionId || !project || !adapter.forkConversation || !adapter.deleteConversation) throw new Error('the adapter must be able to fork and delete');
    const source: ConversationRef = { provider, nativeSessionId: sessionId, projectPath: await realpath(project) };

    const sourceTurns = await loadTurnIds(adapter, source);
    expect(sourceTurns.length).toBeGreaterThanOrEqual(2);

    const fork = await adapter.forkConversation(source, sourceTurns[1], { readOnly: true, title: 'fractal probe (side chat)' });
    try {
      expect(conversationKey(fork)).not.toBe(conversationKey(source));
      // BranchRecord.inheritedTurnCount assumes a fork made after turn index N holds N + 1 turns.
      expect(await loadTurnIds(adapter, fork)).toHaveLength(2);
    } finally {
      await adapter.deleteConversation(fork);
    }

    const remaining = await adapter.listConversations();
    expect(remaining.map((summary) => conversationKey(summary.ref))).not.toContain(conversationKey(fork));
    await expect(loadTurnIds(adapter, fork)).rejects.toThrow();
  }, 120_000);
});
