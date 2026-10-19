import type {
  AccessState,
  AgentModel,
  ConversationImageType,
  ConversationRef,
  ConversationSummary,
  HarnessCapabilities,
  HarnessStatus,
  ModelChoice,
  ProviderId,
  TurnAccess,
  UserDecision,
} from '@/shared/conversation-contract';
import type { NativeEvent } from '@/main/harness/reconciler';

export type NativeEventSink = (event: NativeEvent) => void;
export type Unsubscribe = () => void;

export interface LoadedConversation {
  summary: ConversationSummary;
  events: AsyncIterable<NativeEvent>;
}

/** An attachment resolved to a file on disk; image is set only when the file sniffs as a supported image. */
export interface ResolvedAttachment {
  path: string;
  image?: ConversationImageType;
}

/** How a side chat or fork runs. */
export interface BranchRun {
  /** True for a side chat: the agent must be unable to change anything, enforced by its own machinery. */
  readOnly: boolean;
  note?: string;
}

export interface ForkOptions {
  readOnly: boolean;
  note?: string;
  title: string;
}

export interface AgentPrompt {
  text: string;
  attachments?: ResolvedAttachment[];
  /** Absent means the agent's own default model. */
  model?: string;
  effort?: string;
  /** Absent means the conversation sends no access setting. */
  access?: TurnAccess;
  /** Set by the service on every turn of a side chat or fork. */
  branch?: BranchRun;
}

export interface ConversationRun {
  events: AsyncIterable<NativeEvent>;
  interrupt(): Promise<void>;
  resolveRequest(requestId: string, decision: UserDecision): Promise<void>;
  dispose(): Promise<void>;
}

export interface HarnessAdapter {
  readonly provider: ProviderId;
  probe(): Promise<HarnessStatus>;
  capabilities(): HarnessCapabilities;
  listConversations(): Promise<ConversationSummary[]>;
  loadConversation(ref: ConversationRef): Promise<LoadedConversation>;
  watchConversation(ref: ConversationRef, sink: NativeEventSink): Promise<Unsubscribe>;
  createConversation(projectPath: string): Promise<ConversationRef>;
  continueConversation(ref: ConversationRef, prompt: AgentPrompt): Promise<ConversationRun>;
  /** Copies history through `afterTurnId` (a ConversationTurn.id, inclusive) into a new session. Absent when the agent cannot fork. */
  forkConversation?(source: ConversationRef, afterTurnId: string, options: ForkOptions): Promise<ConversationRef>;
  /** Stores a user-chosen title in the agent's own history. Absent when the agent has no rename. */
  renameConversation?(ref: ConversationRef, title: string): Promise<void>;
  /** The models this agent offers. Absent when it has no way to list them. */
  listModels?(): Promise<AgentModel[]>;
  /** The model and effort this conversation's own history says it last ran with. */
  readLastRun?(ref: ConversationRef): Promise<ModelChoice | undefined>;
  /** The access this conversation's own history says it last ran with. Absent when the agent's history does not record it. */
  readAccess?(ref: ConversationRef): Promise<AccessState | undefined>;
}
