import type {
  ActionStatus,
  AgentAction,
  CaptureCompleteness,
  ConversationTurn,
  TurnBlock,
} from '@/shared/conversation-contract';
import type { NativeEvent } from '@/main/harness/reconciler';

export type TurnProjectionUpdate = { turn: ConversationTurn; finalized: boolean };

type PendingActionResult = {
  status: ActionStatus;
  output?: string;
  exitCode?: number;
  patch?: string;
  observedAt: number;
};

const activeActionStatuses = new Set<ActionStatus>(['requested', 'awaiting-approval', 'running']);
const failedActionStatuses = new Set<ActionStatus>(['failed', 'denied', 'interrupted']);

function lowerCompleteness(
  current: CaptureCompleteness,
  incoming: CaptureCompleteness,
): CaptureCompleteness {
  if (current === 'unknown' || incoming === 'unknown') return 'unknown';
  if (current === 'partial' || incoming === 'partial') return 'partial';
  return 'complete';
}

function actionStatusForTurn(status: ConversationTurn['status']): ActionStatus | null {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'interrupted';
  return null;
}

function isTerminalAction(status: ActionStatus): boolean {
  return !activeActionStatuses.has(status);
}

function snapshot(turn: ConversationTurn): ConversationTurn {
  return structuredClone(turn);
}

export class TurnProjector {
  private current: ConversationTurn | null = null;
  private proseById = new Map<string, Extract<TurnBlock, { kind: 'assistant-prose' }>>();
  private actionById = new Map<string, AgentAction>();
  private pendingActionResults = new Map<string, PendingActionResult>();
  private requestById = new Map<string, Extract<TurnBlock, { kind: 'approval' | 'question' }>>();
  private finishEmitted = false;

  push(event: NativeEvent): TurnProjectionUpdate[] {
    if (event.payload.kind === 'turn-started') return this.startTurn(event);

    const turnId = event.payload.turnId;
    if (!turnId) return [];

    const updates = this.ensureTurn(turnId, event);
    if (!this.current) return updates;

    switch (event.payload.kind) {
      case 'assistant-text':
        this.projectProse(event);
        break;
      case 'action-requested':
        this.projectActionRequested(event);
        break;
      case 'action-updated':
        this.projectActionUpdated(event);
        break;
      case 'request-opened':
        this.projectRequestOpened(event);
        break;
      case 'request-resolved':
        this.projectRequestResolved(event);
        break;
      case 'turn-finished':
        this.finalizeCurrent(event.payload.status, event.observedAt);
        this.finishEmitted = true;
        return [...updates, { turn: snapshot(this.current), finalized: true }];
      case 'system-notice':
        this.current.blocks.push({
          id: event.nativeId,
          kind: 'system-notice',
          message: event.payload.message,
          tone: event.payload.tone,
        });
        break;
      case 'unsupported':
        this.current.blocks.push({
          id: event.nativeId,
          kind: 'unsupported',
          provider: event.provider,
          nativeType: event.nativeType,
          summary: event.payload.summary,
          captureCompleteness: event.payload.captureCompleteness,
        });
        this.current.captureCompleteness = lowerCompleteness(
          this.current.captureCompleteness,
          event.payload.captureCompleteness,
        );
        break;
    }

    if (this.current.status === 'active') this.finishEmitted = false;
    return [...updates, { turn: snapshot(this.current), finalized: false }];
  }

  finish(): TurnProjectionUpdate[] {
    if (!this.current || this.finishEmitted) return [];
    this.finishEmitted = true;
    return [{ turn: snapshot(this.current), finalized: true }];
  }

  private startTurn(event: NativeEvent): TurnProjectionUpdate[] {
    if (event.payload.kind !== 'turn-started') return [];
    const updates: TurnProjectionUpdate[] = [];
    if (this.current && !this.finishEmitted) {
      this.finalizeCurrent('completed', event.observedAt);
      updates.push({ turn: snapshot(this.current), finalized: true });
    }

    const { payload } = event;
    this.current = {
      id: payload.turnId,
      nativeId: event.nativeId,
      userMessage: {
        id: payload.userMessageId,
        text: payload.text,
        ...(payload.createdAt === undefined ? {} : { createdAt: payload.createdAt }),
      },
      blocks: [],
      status: 'active',
      captureCompleteness: 'complete',
    };
    this.proseById = new Map();
    this.actionById = new Map();
    this.pendingActionResults = new Map();
    this.requestById = new Map();
    this.finishEmitted = false;
    updates.push({ turn: snapshot(this.current), finalized: false });
    return updates;
  }

  private ensureTurn(turnId: string, event: NativeEvent): TurnProjectionUpdate[] {
    if (this.current?.id === turnId) return [];

    const updates: TurnProjectionUpdate[] = [];
    if (this.current && !this.finishEmitted) {
      this.finalizeCurrent('completed', event.observedAt);
      updates.push({ turn: snapshot(this.current), finalized: true });
    }

    this.current = {
      id: turnId,
      nativeId: event.nativeId,
      userMessage: { id: `missing-user-message:${turnId}`, text: '' },
      blocks: [],
      status: 'active',
      captureCompleteness: 'partial',
    };
    this.proseById = new Map();
    this.actionById = new Map();
    this.pendingActionResults = new Map();
    this.requestById = new Map();
    this.finishEmitted = false;
    return updates;
  }

  private projectProse(event: NativeEvent): void {
    if (!this.current || event.payload.kind !== 'assistant-text') return;
    const id = event.payload.blockId ?? event.nativeId;
    const existing = this.proseById.get(id);
    if (existing) {
      existing.text = event.payload.text;
      return;
    }

    const block: Extract<TurnBlock, { kind: 'assistant-prose' }> = {
      id,
      kind: 'assistant-prose',
      provider: event.provider,
      text: event.payload.text,
    };
    this.proseById.set(id, block);
    this.current.blocks.push(block);
  }

  private projectActionRequested(event: NativeEvent): void {
    if (!this.current || event.payload.kind !== 'action-requested') return;
    const existing = this.actionById.get(event.payload.actionId);
    const action = this.actionFromRequest(event);

    if (existing) {
      this.replaceAction(existing, action);
      const pending = this.pendingActionResults.get(action.id);
      if (pending) {
        this.applyActionResult(existing, pending);
        this.pendingActionResults.delete(action.id);
      }
      this.refreshPacketStates();
      return;
    }

    this.actionById.set(action.id, action);
    if (event.payload.parentActionId) {
      const parent = this.actionById.get(event.payload.parentActionId);
      if (parent?.kind === 'subagent') {
        parent.actions.push(action);
        return;
      }
      this.current.captureCompleteness = lowerCompleteness(this.current.captureCompleteness, 'partial');
    }
    this.currentPacket(event).actions.push(action);
  }

  private projectActionUpdated(event: NativeEvent): void {
    if (!this.current || event.payload.kind !== 'action-updated') return;
    let action = this.actionById.get(event.payload.actionId);
    if (!action) {
      const pending: PendingActionResult = {
        status: event.payload.status,
        ...(event.payload.output === undefined ? {} : { output: event.payload.output }),
        ...(event.payload.exitCode === undefined ? {} : { exitCode: event.payload.exitCode }),
        ...(event.payload.patch === undefined ? {} : { patch: event.payload.patch }),
        observedAt: event.observedAt,
      };
      action = {
        id: event.payload.actionId,
        nativeId: event.nativeId,
        provider: event.provider,
        kind: 'tool',
        name: event.nativeId,
        inputSummary: event.nativeId,
        status: event.payload.status,
        startedAt: event.observedAt,
        captureCompleteness: 'partial',
      };
      this.actionById.set(action.id, action);
      this.pendingActionResults.set(action.id, pending);
      this.currentPacket(event).actions.push(action);
      this.current.captureCompleteness = lowerCompleteness(this.current.captureCompleteness, 'partial');
    }

    this.applyActionResult(action, {
      status: event.payload.status,
      ...(event.payload.output === undefined ? {} : { output: event.payload.output }),
      ...(event.payload.exitCode === undefined ? {} : { exitCode: event.payload.exitCode }),
      ...(event.payload.patch === undefined ? {} : { patch: event.payload.patch }),
      observedAt: event.observedAt,
    });
    this.refreshPacketStates();
  }

  private applyActionResult(action: AgentAction, result: PendingActionResult): void {
    action.status = result.status;
    if (isTerminalAction(action.status)) action.completedAt = result.observedAt;
    if (action.kind === 'command') {
      if (result.output !== undefined) action.output = result.output;
      if (result.exitCode !== undefined) action.exitCode = result.exitCode;
    } else if (action.kind === 'file-edit' && result.patch !== undefined) {
      action.patch = result.patch;
    } else if (action.kind === 'search' && result.output !== undefined) {
      action.resultSummary = result.output;
    } else if (action.kind === 'tool' && result.output !== undefined) {
      action.outputSummary = result.output;
    }
  }

  private projectRequestOpened(event: NativeEvent): void {
    if (!this.current || event.payload.kind !== 'request-opened') return;
    const action = this.actionById.get(event.payload.request.id);
    if (action) action.status = 'awaiting-approval';

    const request = structuredClone(event.payload.request);
    const existing = this.requestById.get(request.id);
    if (existing) {
      existing.request = request;
    } else {
      const block: Extract<TurnBlock, { kind: 'approval' | 'question' }> = {
        id: request.id,
        kind: request.kind,
        request,
      };
      this.requestById.set(request.id, block);
      this.current.blocks.push(block);
    }
    this.refreshPacketStates();
  }

  private projectRequestResolved(event: NativeEvent): void {
    if (!this.current || event.payload.kind !== 'request-resolved') return;
    const block = this.requestById.get(event.payload.requestId);
    if (!block) return;
    block.request.status = 'resolved';
    block.request.decision = structuredClone(event.payload.decision);
  }

  private actionFromRequest(event: NativeEvent): AgentAction {
    if (event.payload.kind !== 'action-requested') throw new Error('Expected action request');
    const base = {
      id: event.payload.actionId,
      nativeId: event.nativeId,
      provider: event.provider,
      status: 'requested' as const,
      startedAt: event.observedAt,
      captureCompleteness: 'complete' as const,
    };
    const parent = event.payload.parentActionId === undefined
      ? {}
      : { parentNativeId: event.payload.parentActionId };

    switch (event.payload.actionKind) {
      case 'file-read':
        return { ...base, ...parent, kind: 'file-read', path: event.payload.label };
      case 'file-edit':
        return { ...base, ...parent, kind: 'file-edit', path: event.payload.label };
      case 'command':
        return { ...base, ...parent, kind: 'command', command: event.payload.label };
      case 'search':
        return { ...base, ...parent, kind: 'search', query: event.payload.label };
      case 'tool':
        return { ...base, ...parent, kind: 'tool', name: event.payload.label, inputSummary: event.payload.detail ?? event.payload.label };
      case 'subagent':
        return { ...base, ...parent, kind: 'subagent', label: event.payload.label, actions: [] };
    }
  }

  private replaceAction(existing: AgentAction, replacement: AgentAction): void {
    const preserved = {
      status: existing.status,
      completedAt: existing.completedAt,
      captureCompleteness: lowerCompleteness(existing.captureCompleteness, replacement.captureCompleteness),
    };
    const mutableExisting = existing as unknown as Record<string, unknown>;
    Object.keys(mutableExisting).forEach((key) => delete mutableExisting[key]);
    Object.assign(existing, replacement, preserved);
  }

  private currentPacket(event: NativeEvent): Extract<TurnBlock, { kind: 'work-packet' }> {
    if (!this.current) throw new Error('Cannot project an action without a turn');
    const last = this.current.blocks.at(-1);
    if (last?.kind === 'work-packet') return last;
    const packet: Extract<TurnBlock, { kind: 'work-packet' }> = {
      id: `packet:${event.nativeId}`,
      kind: 'work-packet',
      status: 'active',
      actions: [],
      startedAt: event.observedAt,
    };
    this.current.blocks.push(packet);
    return packet;
  }

  private finalizeCurrent(status: Exclude<ConversationTurn['status'], 'active'>, observedAt: number): void {
    if (!this.current) return;
    this.current.status = status;
    const actionStatus = actionStatusForTurn(status);
    this.current.blocks.forEach((block) => {
      if (block.kind !== 'work-packet') return;
      this.finalizeActions(block.actions, actionStatus, observedAt);
    });
    this.refreshPacketStates(observedAt);
  }

  private finalizeActions(actions: AgentAction[], status: ActionStatus | null, observedAt: number): void {
    if (!status) return;
    actions.forEach((action) => {
      if (activeActionStatuses.has(action.status)) {
        action.status = status;
        action.completedAt = observedAt;
      }
      if (action.kind === 'subagent') this.finalizeActions(action.actions, status, observedAt);
    });
  }

  private refreshPacketStates(completedAt?: number): void {
    if (!this.current) return;
    this.current.blocks.forEach((block) => {
      if (block.kind !== 'work-packet') return;
      const statuses = this.flattenActions(block.actions).map((action) => action.status);
      block.status = statuses.some((status) => failedActionStatuses.has(status))
        ? 'failed'
        : statuses.some((status) => activeActionStatuses.has(status))
          ? 'active'
          : 'completed';
      if (block.status !== 'active') block.completedAt = completedAt ?? block.completedAt;
    });
  }

  private flattenActions(actions: AgentAction[]): AgentAction[] {
    return actions.flatMap((action) => action.kind === 'subagent'
      ? [action, ...this.flattenActions(action.actions)]
      : [action]);
  }
}

export function projectTurns(events: NativeEvent[]): ConversationTurn[] {
  const projector = new TurnProjector();
  const turns: ConversationTurn[] = [];
  events.forEach((event) => {
    projector.push(event).forEach((update) => {
      if (update.finalized) turns.push(update.turn);
    });
  });
  projector.finish().forEach((update) => turns.push(update.turn));
  return turns;
}
