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
  /** Owned by the provider's adapter: unique per provider, opaque everywhere else. */
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
  /** Set when another conversation spawned this one; the parent's `ref.nativeSessionId` under the same provider. */
  parentId?: string;
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

export const CONVERSATION_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
/** Longest base64 payload carried inline; larger images are left out rather than rejected. */
export const MAX_CONVERSATION_IMAGE_DATA_LENGTH = 8_000_000;

export type ConversationImageType = (typeof CONVERSATION_IMAGE_TYPES)[number];

export function isConversationImageType(value: unknown): value is ConversationImageType {
  return (CONVERSATION_IMAGE_TYPES as readonly unknown[]).includes(value);
}

/** Most attachments one message may carry. */
export const MAX_PROMPT_ATTACHMENTS = 10;
/** Largest image Fractal sends or previews, in raw bytes; Fractal's own bound on IPC and memory, not a provider limit. */
export const MAX_ATTACHMENT_IMAGE_BYTES = 20 * 1024 * 1024;
/** Base64 length of an image at MAX_ATTACHMENT_IMAGE_BYTES. */
export const MAX_ATTACHMENT_IMAGE_DATA_LENGTH = Math.ceil(MAX_ATTACHMENT_IMAGE_BYTES / 3) * 4;
/** Longest text an attachment preview returns. */
export const ATTACHMENT_PREVIEW_TEXT_BYTES = 256 * 1024;

/** A file the user attached: a path on disk, or a pasted image with no file behind it. */
export type PromptAttachment =
  | { kind: 'path'; path: string }
  | { kind: 'bytes'; name: string; mediaType: ConversationImageType; data: string };

export interface PromptInput {
  text: string;
  attachments?: PromptAttachment[];
}

/** An attachment recorded on a sent user message, by path; contents are fetched through previewAttachment. */
export interface UserMessageAttachment {
  path: string;
  kind: 'image' | 'file';
}

export type AttachmentPreview =
  | { kind: 'image'; image: ConversationImage; size: number; modifiedAt: number }
  | { kind: 'text'; text: string; truncated: boolean; size: number; modifiedAt: number }
  | { kind: 'binary'; size: number; modifiedAt: number }
  | { kind: 'missing' };

export type AttachmentOpenAction = 'open' | 'reveal';

export interface AttachmentsApi {
  /** The file's path on disk, or '' when it has none (for example a pasted screenshot). */
  pathFor(file: File): string;
}

export interface ConversationImage {
  mediaType: ConversationImageType;
  /** Base64 image bytes. */
  data: string;
}

export interface ActionBase {
  id: string;
  nativeId: string;
  provider: ProviderId;
  status: ActionStatus;
  startedAt?: number;
  completedAt?: number;
  captureCompleteness: CaptureCompleteness;
  images?: ConversationImage[];
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
  | { id: string; kind: 'assistant-prose'; text: string; provider: ProviderId; concludesTurn?: true }
  | { id: string; kind: 'work-packet'; status: 'active' | 'completed' | 'failed'; actions: AgentAction[]; startedAt?: number; completedAt?: number }
  | { id: string; kind: 'approval'; request: BlockingRequest }
  | { id: string; kind: 'question'; request: BlockingRequest }
  | { id: string; kind: 'system-notice'; message: string; tone: 'info' | 'warning' | 'error' }
  | { id: string; kind: 'unsupported'; provider: ProviderId; nativeType: string; summary: string; captureCompleteness: CaptureCompleteness };

export interface ConversationTurn {
  id: string;
  nativeId: string;
  userMessage: { id: string; text: string; createdAt?: number; images?: ConversationImage[]; attachments?: UserMessageAttachment[] };
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
  create(input: { provider: ProviderId; projectPath?: string }): Promise<ConversationRef | null>;
  continue(ref: ConversationRef, prompt: PromptInput): Promise<void>;
  interrupt(ref: ConversationRef): Promise<void>;
  resolveRequest(requestId: string, decision: UserDecision): Promise<void>;
  previewAttachment(ref: ConversationRef, path: string): Promise<AttachmentPreview>;
  openAttachment(ref: ConversationRef, path: string, action: AttachmentOpenAction): Promise<void>;
  /** Renames the conversation in its agent's own history; resolves once the agent has it. */
  rename(ref: ConversationRef, title: string): Promise<void>;
  onEvent(listener: (event: ConversationStreamEvent) => void): () => void;
}

export function conversationKey(ref: ConversationRef): string {
  return `${ref.provider}:${ref.nativeSessionId}`;
}
