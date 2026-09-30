import type {
  ConversationImageType,
  ConversationRef,
  ConversationSummary,
  HarnessCapabilities,
  HarnessStatus,
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
}
