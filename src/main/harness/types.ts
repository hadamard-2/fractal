import type {
  AgentModel,
  ConversationImageType,
  ConversationRef,
  ConversationSummary,
  HarnessCapabilities,
  HarnessStatus,
  ModelChoice,
  ProviderId,
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

export interface AgentPrompt {
  text: string;
  attachments?: ResolvedAttachment[];
  /** Absent means the agent's own default model. */
  model?: string;
  effort?: string;
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
  /** Stores a user-chosen title in the agent's own history. Absent when the agent has no rename. */
  renameConversation?(ref: ConversationRef, title: string): Promise<void>;
  /** The models this agent offers. Absent when it has no way to list them. */
  listModels?(): Promise<AgentModel[]>;
  /** The model and effort this conversation's own history says it last ran with. */
  readLastRun?(ref: ConversationRef): Promise<ModelChoice | undefined>;
}
