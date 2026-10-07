import type {
  ActionStatus,
  AgentAction,
  CaptureCompleteness,
  ConversationImage,
  ConversationTurn,
  PlanProposal,
  TurnBlock,
} from '@/shared/conversation-contract';
import { splitAttachmentBlock } from '@/main/harness/attachment-block';
import type { NativeEvent } from '@/main/harness/reconciler';

export type TurnProjectionUpdate = { turn: ConversationTurn; finalized: boolean };

type PendingActionResult = {
  status: ActionStatus;
  output?: string;
  exitCode?: number;
  patch?: string;
  images?: ConversationImage[];
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
  private plan: Extract<TurnBlock, { kind: 'plan' }> | null = null;
  private unanchoredUnsupported: Extract<TurnBlock, { kind: 'unsupported' }>[] = [];
  private unanchoredCompleteness: CaptureCompleteness = 'complete';
  private finishEmitted = false;

  push(event: NativeEvent): TurnProjectionUpdate[] {
    if (event.payload.kind === 'turn-started') return this.startTurn(event);
    if (event.payload.kind === 'unsupported' && !event.payload.turnId) {
      return this.projectUnanchoredUnsupported(event);
    }

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
      case 'plan-proposed':
        this.proposePlan(event, event.payload.planId, event.payload.text);
        break;
      case 'plan-decided': {
        const proposal = this.proposePlan(event, event.payload.planId);
        proposal.status = event.payload.approved ? 'approved' : 'rejected';
        if (event.payload.text) proposal.text = event.payload.text;
        if (event.payload.feedback) proposal.feedback = event.payload.feedback;
        break;
      }
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
    const updates: TurnProjectionUpdate[] = [];
    if (this.current && !this.finishEmitted) {
      this.finishEmitted = true;
      updates.push({ turn: snapshot(this.current), finalized: true });
    }
    if (this.unanchoredUnsupported.length > 0) {
      const { blocks, captureCompleteness } = this.takeUnanchoredUnsupported();
      const first = blocks[0];
      this.current = {
        id: `unanchored:${first.id}`,
        nativeId: first.id,
        userMessage: { id: `missing-user-message:unanchored:${first.id}`, text: '' },
        blocks,
        status: 'active',
        captureCompleteness,
      };
      this.proseById = new Map();
      this.actionById = new Map();
      this.pendingActionResults = new Map();
      this.requestById = new Map();
      this.plan = null;
      this.finishEmitted = true;
      updates.push({
        finalized: true,
        turn: snapshot(this.current),
      });
    }
    return updates;
  }

  private startTurn(event: NativeEvent): TurnProjectionUpdate[] {
    if (event.payload.kind !== 'turn-started') return [];
    const updates: TurnProjectionUpdate[] = [];
    if (this.current?.status === 'active') {
      this.finalizeCurrent('completed', event.observedAt);
      updates.push({ turn: snapshot(this.current), finalized: true });
    }

    const { payload } = event;
    const unanchored = this.takeUnanchoredUnsupported();
    const split = splitAttachmentBlock(payload.text);
    const attachments = [...(payload.attachments ?? []), ...split.paths.map((path) => ({ path, kind: 'file' as const }))];
    this.current = {
      id: payload.turnId,
      nativeId: event.nativeId,
      userMessage: {
        id: payload.userMessageId,
        text: split.text,
        ...(payload.createdAt === undefined ? {} : { createdAt: payload.createdAt }),
        ...(payload.images === undefined ? {} : { images: payload.images }),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      blocks: unanchored.blocks,
      status: 'active',
      captureCompleteness: unanchored.captureCompleteness,
    };
    this.proseById = new Map();
    this.actionById = new Map();
    this.pendingActionResults = new Map();
    this.requestById = new Map();
    this.plan = null;
    this.finishEmitted = false;
    updates.push({ turn: snapshot(this.current), finalized: false });
    return updates;
  }

  private ensureTurn(turnId: string, event: NativeEvent): TurnProjectionUpdate[] {
    if (this.current?.id === turnId) return [];

    const updates: TurnProjectionUpdate[] = [];
    if (this.current?.status === 'active') {
      this.finalizeCurrent('completed', event.observedAt);
      updates.push({ turn: snapshot(this.current), finalized: true });
    }

    const unanchored = this.takeUnanchoredUnsupported();
    this.current = {
      id: turnId,
      nativeId: event.nativeId,
      userMessage: { id: `missing-user-message:${turnId}`, text: '' },
      blocks: unanchored.blocks,
      status: 'active',
      captureCompleteness: lowerCompleteness('partial', unanchored.captureCompleteness),
    };
    this.proseById = new Map();
    this.actionById = new Map();
    this.pendingActionResults = new Map();
    this.requestById = new Map();
    this.plan = null;
    this.finishEmitted = false;
    return updates;
  }

  private projectProse(event: NativeEvent): void {
    if (!this.current || event.payload.kind !== 'assistant-text') return;
    const id = event.payload.blockId ?? event.nativeId;
    const existing = this.proseById.get(id);
    if (existing) {
      existing.text = event.payload.text;
      if (event.payload.concludesTurn) existing.concludesTurn = true;
      return;
    }

    const block: Extract<TurnBlock, { kind: 'assistant-prose' }> = {
      id,
      kind: 'assistant-prose',
      provider: event.provider,
      text: event.payload.text,
      ...(event.payload.concludesTurn ? { concludesTurn: true as const } : {}),
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
        this.refreshPacketStates();
        return;
      }
      this.current.captureCompleteness = lowerCompleteness(this.current.captureCompleteness, 'partial');
    }
    this.currentPacket(event).actions.push(action);
    this.refreshPacketStates();
  }

  private projectActionUpdated(event: NativeEvent): void {
    if (!this.current || event.payload.kind !== 'action-updated') return;
    let action = this.actionById.get(event.payload.actionId);
    const result = this.resultFromEvent(event);
    if (!action) {
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
      this.pendingActionResults.set(action.id, result);
      this.currentPacket(event).actions.push(action);
      this.current.captureCompleteness = lowerCompleteness(this.current.captureCompleteness, 'partial');
    } else {
      const pending = this.pendingActionResults.get(action.id);
      if (pending) this.pendingActionResults.set(action.id, this.mergePendingResult(pending, result));
    }

    this.applyActionResult(action, result);
    this.refreshPacketStates();
  }

  private resultFromEvent(event: NativeEvent): PendingActionResult {
    if (event.payload.kind !== 'action-updated') throw new Error('Expected action update');
    return {
      status: event.payload.status,
      ...(event.payload.output === undefined ? {} : { output: event.payload.output }),
      ...(event.payload.exitCode === undefined ? {} : { exitCode: event.payload.exitCode }),
      ...(event.payload.patch === undefined ? {} : { patch: event.payload.patch }),
      ...(event.payload.images === undefined ? {} : { images: event.payload.images }),
      observedAt: event.observedAt,
    };
  }

  private mergePendingResult(
    previous: PendingActionResult,
    incoming: PendingActionResult,
  ): PendingActionResult {
    return {
      ...previous,
      ...incoming,
      ...(incoming.output === undefined && previous.output !== undefined ? { output: previous.output } : {}),
      ...(incoming.exitCode === undefined && previous.exitCode !== undefined ? { exitCode: previous.exitCode } : {}),
      ...(incoming.patch === undefined && previous.patch !== undefined ? { patch: previous.patch } : {}),
      ...(incoming.images === undefined && previous.images !== undefined ? { images: previous.images } : {}),
    };
  }

  private applyActionResult(action: AgentAction, result: PendingActionResult): void {
    action.status = result.status;
    if (isTerminalAction(action.status)) action.completedAt = result.observedAt;
    if (result.images !== undefined) action.images = result.images;
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
    const { request: opened } = event.payload;
    if (opened.kind === 'approval' && opened.plan !== undefined) this.proposePlan(event, opened.id, opened.plan || undefined);

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
    const { decision, requestId } = event.payload;
    const proposal = this.plan?.proposals.find((item) => item.id === requestId);
    if (proposal?.status === 'proposed') {
      proposal.status = decision.kind === 'deny' ? 'rejected' : 'approved';
      if (decision.kind === 'deny' && decision.reason) proposal.feedback = decision.reason;
    }
  }

  /** The turn's plan proposal with this id, added as the latest one if new; a new proposal moves the plan to the end of the turn. */
  private proposePlan(event: NativeEvent, planId: string, text?: string): PlanProposal {
    if (!this.current) throw new Error('Cannot project a plan without a turn');
    const existing = this.plan?.proposals.find((proposal) => proposal.id === planId);
    if (existing) {
      if (text) existing.text = text;
      return existing;
    }
    const proposal: PlanProposal = { id: planId, status: 'proposed', ...(text ? { text } : {}) };
    if (this.plan) {
      this.current.blocks.splice(this.current.blocks.indexOf(this.plan), 1);
      this.plan.proposals.push(proposal);
    } else {
      this.plan = { id: `plan:${planId}`, kind: 'plan', provider: event.provider, proposals: [proposal] };
    }
    this.current.blocks.push(this.plan);
    return proposal;
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
      startedAt: existing.startedAt ?? replacement.startedAt,
      ...(existing.completedAt === undefined ? {} : { completedAt: existing.completedAt }),
      captureCompleteness: lowerCompleteness(existing.captureCompleteness, replacement.captureCompleteness),
    } as Record<string, unknown>;
    const merged = { ...replacement, ...preserved } as unknown as Record<string, unknown>;
    if (replacement.kind === 'command' && existing.kind === 'command') {
      if (existing.output !== undefined) merged.output = existing.output;
      if (existing.exitCode !== undefined) merged.exitCode = existing.exitCode;
    } else if (replacement.kind === 'file-edit' && existing.kind === 'file-edit' && existing.patch !== undefined) {
      merged.patch = existing.patch;
    } else if (replacement.kind === 'search' && existing.kind === 'search' && existing.resultSummary !== undefined) {
      merged.resultSummary = existing.resultSummary;
    } else if (replacement.kind === 'tool' && existing.kind === 'tool' && existing.outputSummary !== undefined) {
      merged.outputSummary = existing.outputSummary;
    } else if (replacement.kind === 'subagent' && existing.kind === 'subagent') {
      merged.actions = existing.actions;
    }
    const mutableExisting = existing as unknown as Record<string, unknown>;
    Object.keys(mutableExisting).forEach((key) => delete mutableExisting[key]);
    Object.assign(existing, merged);
  }

  private projectUnanchoredUnsupported(event: NativeEvent): TurnProjectionUpdate[] {
    if (event.payload.kind !== 'unsupported') return [];
    const block: Extract<TurnBlock, { kind: 'unsupported' }> = {
      id: event.nativeId,
      kind: 'unsupported',
      provider: event.provider,
      nativeType: event.nativeType,
      summary: event.payload.summary,
      captureCompleteness: event.payload.captureCompleteness,
    };
    if (!this.current || this.current.status !== 'active') {
      this.unanchoredUnsupported.push(block);
      this.unanchoredCompleteness = lowerCompleteness(
        this.unanchoredCompleteness,
        event.payload.captureCompleteness,
      );
      return [];
    }
    this.current.blocks.push(block);
    this.current.captureCompleteness = lowerCompleteness(
      this.current.captureCompleteness,
      event.payload.captureCompleteness,
    );
    if (this.current.status === 'active') this.finishEmitted = false;
    return [{ turn: snapshot(this.current), finalized: false }];
  }

  private takeUnanchoredUnsupported(): {
    blocks: Extract<TurnBlock, { kind: 'unsupported' }>[];
    captureCompleteness: CaptureCompleteness;
  } {
    const result = {
      blocks: this.unanchoredUnsupported,
      captureCompleteness: this.unanchoredCompleteness,
    };
    this.unanchoredUnsupported = [];
    this.unanchoredCompleteness = 'complete';
    return result;
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
      if (block.kind === 'plan') {
        block.proposals.forEach((proposal) => { if (proposal.status === 'proposed') proposal.status = 'interrupted'; });
      }
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
      block.status = statuses.some((status) => activeActionStatuses.has(status))
        ? 'active'
        : statuses.some((status) => failedActionStatuses.has(status))
          ? 'failed'
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
