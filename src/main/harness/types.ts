import type {
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
  continueConversation(ref: ConversationRef, prompt: { text: string }): Promise<ConversationRun>;
}
