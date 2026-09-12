import { describe, expect, test } from 'vitest';
import { projectTurns, TurnProjector } from '@/main/harness/turn-projector';
import type { NativeEvent } from '@/main/harness/reconciler';

const event = (nativeId: string, observedAt: number, payload: NativeEvent['payload']): NativeEvent => ({
  provider: 'codex',
  nativeId,
  nativeType: payload.kind,
  observedAt,
  payload,
});

describe('projectTurns', () => {
  test('keeps prose and consecutive actions in source order', () => {
    const events: NativeEvent[] = [
      event('u1', 1, { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'Inspect it' }),
      event('m1', 2, { kind: 'assistant-text', turnId: 't1', text: 'I will inspect it.', final: true }),
      event('a1', 3, { kind: 'action-requested', turnId: 't1', actionId: 'a1', actionKind: 'command', label: 'pnpm lint' }),
      event('a1:done', 4, { kind: 'action-updated', turnId: 't1', actionId: 'a1', status: 'completed', exitCode: 0 }),
      event('m2', 5, { kind: 'assistant-text', turnId: 't1', text: 'It passes.', final: true }),
      event('t1:done', 6, { kind: 'turn-finished', turnId: 't1', status: 'completed' }),
    ];

    const [turn] = projectTurns(events);

    expect(turn.blocks.map((block) => block.kind)).toEqual(['assistant-prose', 'work-packet', 'assistant-prose']);
    expect(turn.status).toBe('completed');
  });

  test('nests subagent activity and preserves unsupported records', () => {
    const events: NativeEvent[] = [
      event('u2', 1, { kind: 'turn-started', turnId: 't2', userMessageId: 'u2', text: 'Delegate this' }),
      event('parent', 2, { kind: 'action-requested', turnId: 't2', actionId: 'parent', actionKind: 'subagent', label: 'Explore agent' }),
      event('child', 3, { kind: 'action-requested', turnId: 't2', actionId: 'child', actionKind: 'file-read', label: 'src/App.tsx', parentActionId: 'parent' }),
      event('child:done', 4, { kind: 'action-updated', turnId: 't2', actionId: 'child', status: 'completed' }),
      event('future', 5, { kind: 'unsupported', turnId: 't2', summary: 'Unsupported Codex activity: future_event', captureCompleteness: 'partial' }),
      event('t2:done', 6, { kind: 'turn-finished', turnId: 't2', status: 'completed' }),
    ];

    const [turn] = projectTurns(events);
    const packet = turn.blocks.find((block) => block.kind === 'work-packet');
    const parent = packet?.kind === 'work-packet' ? packet.actions.find((action) => action.nativeId === 'parent') : undefined;

    expect(turn.blocks.some((block) => block.kind === 'unsupported')).toBe(true);
    expect(parent?.kind).toBe('subagent');
    expect(parent?.kind === 'subagent' ? parent.actions[0].nativeId : null).toBe('child');
    expect(turn.captureCompleteness).toBe('partial');
  });

  test('replaces a streaming prose block instead of appending duplicate final text', () => {
    const [turn] = projectTurns([
      event('u1', 1, { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'Inspect it' }),
      event('m1', 2, { kind: 'assistant-text', turnId: 't1', blockId: 'prose-1', text: 'I will ', final: false }),
      event('m1-final', 3, { kind: 'assistant-text', turnId: 't1', blockId: 'prose-1', text: 'I will inspect it.', final: true }),
    ]);

    expect(turn.blocks).toEqual([
      { id: 'prose-1', kind: 'assistant-prose', provider: 'codex', text: 'I will inspect it.' },
    ]);
  });

  test('merges action output, patch, and exit code without changing action position', () => {
    const [turn] = projectTurns([
      event('u1', 1, { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'Edit it' }),
      event('edit', 2, { kind: 'action-requested', turnId: 't1', actionId: 'edit', actionKind: 'file-edit', label: 'src/App.tsx' }),
      event('command', 3, { kind: 'action-requested', turnId: 't1', actionId: 'command', actionKind: 'command', label: 'pnpm lint' }),
      event('edit:done', 4, { kind: 'action-updated', turnId: 't1', actionId: 'edit', status: 'completed', patch: '@@ -1 +1 @@' }),
      event('command:done', 5, { kind: 'action-updated', turnId: 't1', actionId: 'command', status: 'failed', output: 'bad', exitCode: 1 }),
    ]);
    const packet = turn.blocks[0];

    expect(packet).toMatchObject({
      kind: 'work-packet',
      status: 'failed',
      actions: [
        { id: 'edit', kind: 'file-edit', path: 'src/App.tsx', patch: '@@ -1 +1 @@', status: 'completed' },
        { id: 'command', kind: 'command', command: 'pnpm lint', output: 'bad', exitCode: 1, status: 'failed' },
      ],
    });
  });

  test('retains a resolved approval block and marks its matching action awaiting approval', () => {
    const decision = { kind: 'allow-once' } as const;
    const [turn] = projectTurns([
      event('u1', 1, { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'Run it' }),
      event('request-1', 2, { kind: 'action-requested', turnId: 't1', actionId: 'request-1', actionKind: 'command', label: 'pnpm lint' }),
      event('request-open', 3, { kind: 'request-opened', turnId: 't1', request: { id: 'request-1', kind: 'approval', provider: 'codex', title: 'Allow command', operation: 'pnpm lint', status: 'open' } }),
      event('request-resolved', 4, { kind: 'request-resolved', turnId: 't1', requestId: 'request-1', decision }),
    ]);
    const packet = turn.blocks[0];
    const approval = turn.blocks[1];

    expect(packet).toMatchObject({ kind: 'work-packet', actions: [{ id: 'request-1', status: 'awaiting-approval' }] });
    expect(approval).toEqual({
      id: 'request-1',
      kind: 'approval',
      request: { id: 'request-1', kind: 'approval', provider: 'codex', title: 'Allow command', operation: 'pnpm lint', status: 'resolved', decision },
    });
  });

  test('keeps an update before its request as a partial tool action', () => {
    const [turn] = projectTurns([
      event('u1', 1, { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'Run it' }),
      event('result-first', 2, { kind: 'action-updated', turnId: 't1', actionId: 'lost-request', status: 'completed', output: 'ok' }),
    ]);
    const packet = turn.blocks[0];

    expect(packet).toMatchObject({
      kind: 'work-packet',
      actions: [{ id: 'lost-request', nativeId: 'result-first', kind: 'tool', name: 'result-first', outputSummary: 'ok', status: 'completed', captureCompleteness: 'partial' }],
    });
    expect(turn.captureCompleteness).toBe('partial');
  });

  test('retains an early result when its later request provides the action details', () => {
    const [turn] = projectTurns([
      event('u1', 1, { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'Run it' }),
      event('result-first', 2, { kind: 'action-updated', turnId: 't1', actionId: 'command-1', status: 'completed', output: 'ok', exitCode: 0 }),
      event('command-request', 3, { kind: 'action-requested', turnId: 't1', actionId: 'command-1', actionKind: 'command', label: 'pnpm lint' }),
    ]);
    const packet = turn.blocks[0];

    expect(packet).toMatchObject({
      kind: 'work-packet',
      actions: [{ id: 'command-1', nativeId: 'command-request', kind: 'command', command: 'pnpm lint', output: 'ok', exitCode: 0, status: 'completed', captureCompleteness: 'partial' }],
    });
  });

  test('keeps a packet active when a new requested action follows a failed action', () => {
    const [turn] = projectTurns([
      event('u1', 1, { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'Run checks' }),
      event('a1', 2, { kind: 'action-requested', turnId: 't1', actionId: 'a1', actionKind: 'command', label: 'pnpm lint' }),
      event('a1:failed', 3, { kind: 'action-updated', turnId: 't1', actionId: 'a1', status: 'failed', exitCode: 1 }),
      event('a2', 4, { kind: 'action-requested', turnId: 't1', actionId: 'a2', actionKind: 'command', label: 'pnpm test' }),
    ]);

    expect(turn.blocks[0]).toMatchObject({
      kind: 'work-packet',
      status: 'active',
      actions: [{ id: 'a1', status: 'failed' }, { id: 'a2', status: 'requested' }],
    });
  });

  test('merges every pre-request result so the latest fields win when the request arrives', () => {
    const [turn] = projectTurns([
      event('u1', 1, { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'Run checks' }),
      event('result-1', 2, { kind: 'action-updated', turnId: 't1', actionId: 'a1', status: 'running', output: 'halfway' }),
      event('result-2', 3, { kind: 'action-updated', turnId: 't1', actionId: 'a1', status: 'failed', output: 'failed', exitCode: 1 }),
      event('request', 4, { kind: 'action-requested', turnId: 't1', actionId: 'a1', actionKind: 'command', label: 'pnpm lint' }),
    ]);

    expect(turn.blocks[0]).toMatchObject({
      kind: 'work-packet',
      status: 'failed',
      actions: [{ id: 'a1', kind: 'command', status: 'failed', output: 'failed', exitCode: 1, completedAt: 3 }],
    });
  });

  test('attaches an unanchored unsupported record to the next turn with partial completeness', () => {
    const projector = new TurnProjector();

    projector.push(event('future', 1, { kind: 'unsupported', summary: 'Future provider record', captureCompleteness: 'partial' }));
    const updates = projector.push(event('u1', 2, { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'Inspect it' }));

    expect(updates.at(-1)).toMatchObject({
      finalized: false,
      turn: {
        captureCompleteness: 'partial',
        blocks: [{ id: 'future', kind: 'unsupported', provider: 'codex', nativeType: 'unsupported', summary: 'Future provider record', captureCompleteness: 'partial' }],
      },
    });
  });

  test('buffers an unsupported record after a completed turn for the next turn anchor', () => {
    const projector = new TurnProjector();

    projector.push(event('u1', 1, { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'First' }));
    projector.push(event('t1:done', 2, { kind: 'turn-finished', turnId: 't1', status: 'completed' }));
    projector.push(event('future', 3, { kind: 'unsupported', summary: 'Future provider record', captureCompleteness: 'unknown' }));
    const updates = projector.push(event('u2', 4, { kind: 'turn-started', turnId: 't2', userMessageId: 'u2', text: 'Second' }));

    expect(updates.at(-1)).toMatchObject({
      finalized: false,
      turn: {
        id: 't2',
        captureCompleteness: 'unknown',
        blocks: [{ id: 'future', kind: 'unsupported', captureCompleteness: 'unknown' }],
      },
    });
  });

  test('upserts repeated requests without erasing result fields, timing, or subagent children', () => {
    const [turn] = projectTurns([
      event('u1', 1, { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'Inspect it' }),
      event('command-1', 2, { kind: 'action-requested', turnId: 't1', actionId: 'command', actionKind: 'command', label: 'pnpm lint' }),
      event('command-result', 3, { kind: 'action-updated', turnId: 't1', actionId: 'command', status: 'failed', output: 'bad', exitCode: 1 }),
      event('command-2', 4, { kind: 'action-requested', turnId: 't1', actionId: 'command', actionKind: 'command', label: 'pnpm lint --fix' }),
      event('parent-1', 5, { kind: 'action-requested', turnId: 't1', actionId: 'parent', actionKind: 'subagent', label: 'Explore agent' }),
      event('child', 6, { kind: 'action-requested', turnId: 't1', actionId: 'child', actionKind: 'file-read', label: 'src/App.tsx', parentActionId: 'parent' }),
      event('child-result', 7, { kind: 'action-updated', turnId: 't1', actionId: 'child', status: 'failed' }),
      event('parent-2', 8, { kind: 'action-requested', turnId: 't1', actionId: 'parent', actionKind: 'subagent', label: 'Explore again' }),
    ]);
    const packet = turn.blocks[0];
    const command = packet.kind === 'work-packet' ? packet.actions.find((action) => action.id === 'command') : undefined;
    const parent = packet.kind === 'work-packet' ? packet.actions.find((action) => action.id === 'parent') : undefined;

    expect(packet).toMatchObject({ kind: 'work-packet', status: 'active' });
    expect(command).toMatchObject({
      nativeId: 'command-2',
      kind: 'command',
      command: 'pnpm lint --fix',
      status: 'failed',
      output: 'bad',
      exitCode: 1,
      startedAt: 2,
      completedAt: 3,
    });
    expect(parent).toMatchObject({
      nativeId: 'parent-2',
      kind: 'subagent',
      label: 'Explore again',
      startedAt: 5,
      actions: [{ id: 'child', status: 'failed', completedAt: 7 }],
    });
  });
});

describe('TurnProjector lifecycle', () => {
  test('finalizes the prior turn on the next turn start and finalizes active actions when the turn ends', () => {
    const projector = new TurnProjector();

    projector.push(event('u1', 1, { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'First' }));
    projector.push(event('a1', 2, { kind: 'action-requested', turnId: 't1', actionId: 'a1', actionKind: 'command', label: 'pnpm lint' }));
    const next = projector.push(event('u2', 3, { kind: 'turn-started', turnId: 't2', userMessageId: 'u2', text: 'Second' }));
    const done = projector.push(event('t2:done', 4, { kind: 'turn-finished', turnId: 't2', status: 'completed' }));

    expect(next[0]).toMatchObject({ finalized: true, turn: { id: 't1', status: 'completed', blocks: [{ kind: 'work-packet', status: 'completed', actions: [{ status: 'completed' }] }] } });
    expect(done).toMatchObject([{ finalized: true, turn: { id: 't2', status: 'completed' } }]);
  });

  test('emits finish once while keeping an active turn open to later watch events', () => {
    const projector = new TurnProjector();

    projector.push(event('u1', 1, { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'Wait' }));
    const firstFinish = projector.finish();
    const secondFinish = projector.finish();
    const update = projector.push(event('m1', 2, { kind: 'assistant-text', turnId: 't1', text: 'Still working', final: false }));

    expect(firstFinish).toMatchObject([{ finalized: true, turn: { id: 't1', status: 'active' } }]);
    expect(secondFinish).toEqual([]);
    expect(update).toMatchObject([{ finalized: false, turn: { blocks: [{ kind: 'assistant-prose', text: 'Still working' }] } }]);
  });

  test('finalizes an active turn at the next boundary even after finish emitted a snapshot', () => {
    const projector = new TurnProjector();

    projector.push(event('u1', 1, { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'First' }));
    projector.push(event('a1', 2, { kind: 'action-requested', turnId: 't1', actionId: 'a1', actionKind: 'command', label: 'pnpm lint' }));
    projector.finish();
    const boundary = projector.push(event('u2', 3, { kind: 'turn-started', turnId: 't2', userMessageId: 'u2', text: 'Second' }));

    expect(boundary[0]).toMatchObject({
      finalized: true,
      turn: { id: 't1', status: 'completed', blocks: [{ kind: 'work-packet', status: 'completed', actions: [{ status: 'completed' }] }] },
    });
  });
});
