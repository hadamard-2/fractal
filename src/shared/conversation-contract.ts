export type ProviderId = 'codex' | 'claude';

export type ConversationRuntime =
  | 'idle'
  | 'active-in-fractal'
  | 'waiting-for-user'
  | 'active-externally'
  | 'unknown'
  | 'failed';

export type CaptureCompleteness = 'complete' | 'partial' | 'unknown';

export interface ConversationRef {
  provider: ProviderId;
  nativeSessionId: string;
  projectPath: string;
}

export interface HarnessCapabilities {
  create: boolean;
  partialStreaming: boolean;
  approvals: boolean;
  questions: boolean;
  interrupt: boolean;
  steerWhileRunning: boolean;
  fork: boolean;
}

export interface HarnessStatus {
  provider: ProviderId;
  availability: 'available' | 'unavailable' | 'unsupported' | 'unauthenticated';
  version?: string;
  message?: string;
  capabilities: HarnessCapabilities;
}

export interface ConversationSummary {
  ref: ConversationRef;
  title: string;
  updatedAt: number;
  createdAt?: number;
  runtime: ConversationRuntime;
  captureCompleteness: CaptureCompleteness;
}

export interface ProjectConversationGroup {
  projectPath: string;
  displayName: string;
  conversations: ConversationSummary[];
}

export type ActionStatus =
  | 'requested'
  | 'awaiting-approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'interrupted';

export interface ActionBase {
  id: string;
  nativeId: string;
  provider: ProviderId;
  status: ActionStatus;
  startedAt?: number;
  completedAt?: number;
  captureCompleteness: CaptureCompleteness;
}

export type AgentAction =
  | (ActionBase & { kind: 'file-read'; path: string })
  | (ActionBase & { kind: 'file-edit'; path: string; patch?: string })
  | (ActionBase & { kind: 'command'; command: string; cwd?: string; output?: string; exitCode?: number })
  | (ActionBase & { kind: 'search'; query: string; scope?: string; resultSummary?: string })
  | (ActionBase & { kind: 'tool'; name: string; inputSummary: string; outputSummary?: string })
  | (ActionBase & { kind: 'subagent'; label: string; parentNativeId?: string; actions: AgentAction[] });

export type UserDecision =
  | { kind: 'allow-once' }
  | { kind: 'allow-and-remember'; scope: string }
  | { kind: 'deny'; reason?: string }
  | { kind: 'answer'; answers: Record<string, string> };

export type BlockingRequest =
  | { id: string; kind: 'approval'; provider: ProviderId; title: string; operation: string; rememberScope?: string; status: 'open' | 'resolved'; decision?: UserDecision }
  | { id: string; kind: 'question'; provider: ProviderId; prompt: string; fieldId: string; choices?: Array<{ value: string; label: string }>; allowFreeText: boolean; status: 'open' | 'resolved'; decision?: UserDecision };

export type TurnBlock =
  | { id: string; kind: 'assistant-prose'; text: string; provider: ProviderId }
  | { id: string; kind: 'work-packet'; status: 'active' | 'completed' | 'failed'; actions: AgentAction[]; startedAt?: number; completedAt?: number }
  | { id: string; kind: 'approval'; request: BlockingRequest }
  | { id: string; kind: 'question'; request: BlockingRequest }
  | { id: string; kind: 'system-notice'; message: string; tone: 'info' | 'warning' | 'error' }
  | { id: string; kind: 'unsupported'; provider: ProviderId; nativeType: string; summary: string; captureCompleteness: CaptureCompleteness };

export interface ConversationTurn {
  id: string;
  nativeId: string;
  userMessage: { id: string; text: string; createdAt?: number };
  blocks: TurnBlock[];
  status: 'active' | 'completed' | 'interrupted' | 'failed';
  captureCompleteness: CaptureCompleteness;
}

export type ConversationStreamEvent = {
  loadId: string;
  seq: number;
  ref: ConversationRef;
} & (
  | { type: 'history.chunk'; chunkIndex: number; turns: ConversationTurn[] }
  | { type: 'history.complete' }
  | { type: 'turn.upserted'; turn: ConversationTurn }
  | { type: 'assistant.delta'; turnId: string; blockId: string; delta: string }
  | { type: 'action.upserted'; turnId: string; packetId: string; action: AgentAction }
  | { type: 'runtime.changed'; runtime: ConversationRuntime }
  | { type: 'request.opened'; request: BlockingRequest }
  | { type: 'request.resolved'; requestId: string; decision: UserDecision }
  | { type: 'summary.updated'; summary: ConversationSummary }
  | { type: 'load.failed'; message: string }
);

export interface ConversationApi {
  list(): Promise<{ projects: ProjectConversationGroup[]; providers: HarnessStatus[] }>;
  open(ref: ConversationRef, loadId: string): Promise<{ summary: ConversationSummary; capabilities: HarnessCapabilities }>;
  close(ref: ConversationRef): Promise<void>;
  create(input: { provider: ProviderId }): Promise<ConversationRef | null>;
  continue(ref: ConversationRef, prompt: { text: string }): Promise<void>;
  interrupt(ref: ConversationRef): Promise<void>;
  resolveRequest(requestId: string, decision: UserDecision): Promise<void>;
  onEvent(listener: (event: ConversationStreamEvent) => void): () => void;
}

export function conversationKey(ref: ConversationRef): string {
  return `${ref.provider}:${ref.nativeSessionId}`;
}
