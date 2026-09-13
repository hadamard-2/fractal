import { access, realpath } from 'node:fs/promises';
import { canonicalizeProjectPath, type Realpath } from '@/main/harness/project-path';
import { discoverClaudeConversations, readClaudeConversation, watchClaudeConversation } from '@/main/harness/claude/claude-history';
import type { ConversationRun, HarnessAdapter, LoadedConversation, NativeEventSink, Unsubscribe } from '@/main/harness/types';
import type { ConversationRef, ConversationSummary, HarnessCapabilities, HarnessStatus } from '@/shared/conversation-contract';
import { parseConversationRef } from '@/shared/conversation-ipc';

const CAPABILITIES: HarnessCapabilities = {
  create: false, partialStreaming: false, approvals: false, questions: false,
  interrupt: false, steerWhileRunning: false, fork: false,
};

/** Read-only composition of native discovery, normalized history, and file watches. */
export class ClaudeAdapter implements HarnessAdapter {
  readonly provider = 'claude' as const;

  constructor(private readonly rootDir: string, private readonly dependencies: { realpath?: Realpath } = {}) {}

  async probe(): Promise<HarnessStatus> {
    try {
      await access(this.rootDir);
      return { provider: 'claude', availability: 'available', capabilities: this.capabilities() };
    } catch {
      return { provider: 'claude', availability: 'unavailable', message: 'Claude conversation history is unavailable.', capabilities: this.capabilities() };
    }
  }

  capabilities(): HarnessCapabilities { return { ...CAPABILITIES }; }

  async listConversations(): Promise<ConversationSummary[]> {
    return Promise.all((await discoverClaudeConversations(this.rootDir)).map(async ({ summary }) => ({
      ...summary, ref: { ...summary.ref, projectPath: await this.canonicalPath(summary.ref.projectPath) },
    })));
  }

  async loadConversation(ref: ConversationRef): Promise<LoadedConversation> {
    const found = await this.find(ref);
    const read = readClaudeConversation(found.filePath);
    // The iterator surfaces read failures; also consume the reader's parallel completion rejection.
    void read.completion.catch((): void => undefined);
    return { summary: found.summary, events: read.events };
  }

  async watchConversation(ref: ConversationRef, sink: NativeEventSink): Promise<Unsubscribe> {
    return watchClaudeConversation((await this.find(ref)).filePath, sink);
  }

  async createConversation(projectPath: string): Promise<ConversationRef> {
    void projectPath;
    throw new Error('Claude conversation creation is not available yet');
  }

  async continueConversation(ref: ConversationRef, prompt: { text: string }): Promise<ConversationRun> {
    void ref; void prompt;
    throw new Error('Claude conversation continuation is not available yet');
  }

  private async find(input: ConversationRef) {
    const ref = parseConversationRef(input);
    if (ref.provider !== 'claude') throw new Error('Conversation provider must be claude');
    const projectPath = await this.canonicalPath(ref.projectPath);
    for (const found of await discoverClaudeConversations(this.rootDir)) {
      if (found.ref.nativeSessionId !== ref.nativeSessionId || await this.canonicalPath(found.ref.projectPath) !== projectPath) continue;
      return { filePath: found.filePath, summary: { ...found.summary, ref: { ...ref, projectPath } } };
    }
    throw new Error('Claude conversation is not currently available in this project');
  }

  private canonicalPath(value: string): Promise<string> {
    return canonicalizeProjectPath(value, this.dependencies.realpath ?? (async (input) => realpath(input).catch(() => input)));
  }
}
