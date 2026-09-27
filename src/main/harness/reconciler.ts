import type {
  ActionStatus,
  BlockingRequest,
  CaptureCompleteness,
  ProviderId,
  UserDecision,
} from '@/shared/conversation-contract';

export type NativeEventPayload =
  | { kind: 'turn-started'; turnId: string; userMessageId: string; text: string; createdAt?: number }
  // concludesTurn: the provider marked the message this text belongs to as the one that ended the turn.
  | { kind: 'assistant-text'; turnId: string; blockId?: string; text: string; final: boolean; concludesTurn?: true }
  | { kind: 'action-requested'; turnId: string; actionId: string; actionKind: 'file-read' | 'file-edit' | 'command' | 'search' | 'tool' | 'subagent'; label: string; parentActionId?: string; detail?: string }
  | { kind: 'action-updated'; turnId: string; actionId: string; status: ActionStatus; output?: string; exitCode?: number; patch?: string }
  | { kind: 'request-opened'; turnId: string; request: BlockingRequest }
  | { kind: 'request-resolved'; turnId: string; requestId: string; decision: UserDecision }
  | { kind: 'turn-finished'; turnId: string; status: 'completed' | 'interrupted' | 'failed' }
  | { kind: 'system-notice'; turnId?: string; message: string; tone: 'info' | 'warning' | 'error' }
  | { kind: 'unsupported'; turnId?: string; summary: string; captureCompleteness: CaptureCompleteness };

export interface NativeEvent {
  provider: ProviderId;
  nativeId: string;
  nativeType: string;
  observedAt: number;
  payload: NativeEventPayload;
}

export function nativeEventKey(event: NativeEvent): string {
  return `${event.provider}:${event.nativeId}`;
}

export function reconcileNativeEvents(
  existing: readonly NativeEvent[],
  incoming: readonly NativeEvent[],
): NativeEvent[] {
  const result: NativeEvent[] = [];
  const slots = new Map<string, number>();

  const merge = (event: NativeEvent): void => {
    const key = nativeEventKey(event);
    const slot = slots.get(key);
    if (slot === undefined) {
      slots.set(key, result.length);
      result.push(event);
    } else {
      result[slot] = event;
    }
  };

  existing.forEach(merge);
  incoming.forEach(merge);
  return result;
}
