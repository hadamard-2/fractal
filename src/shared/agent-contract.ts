// Shared agent IPC contract. Type-only (plus small pure guards) — no I/O, no
// Electron imports, no React. Imported by both the main and renderer
// processes; the single source of truth for the shape.
//
// See docs/superpowers/specs/2026-08-21-execute-mode-ipc-message-shape-design.md
// for the full design rationale. Types below are transcribed from that spec's
// sections 1-3.

// --- 1. Data model (the entry) ---------------------------------------------

export type ConversationId = string; // uuid, minted by main
export type EntryId = string;
export type PartId = string;

export interface Conversation {
  id: ConversationId;
  title: string;
  repoRoot: string; // paths in parts/provenance are relative to this
  createdAt: number; // epoch ms
  updatedAt: number;
  schemaVersion: number;
}

export interface Entry {
  id: EntryId;
  conversationId: ConversationId;
  author: 'user' | 'agent';
  createdAt: number;
  status: 'streaming' | 'complete' | 'interrupted' | 'error';
  error?: { message: string };
  parts: Part[];
  provenance?: Provenance; // agent entries only
}

export type Part = TextPart | ReasoningPart | WorkPart;

export interface TextPart {
  id: PartId;
  kind: 'text';
  text: string;
}

export interface ReasoningPart {
  id: PartId;
  kind: 'reasoning';
  text: string;
}

export interface WorkBase {
  id: PartId;
  startedAt: number;
  endedAt?: number;
  phase: 'pending' | 'awaiting-permission' | 'running' | 'done' | 'denied' | 'error';
  error?: { message: string };
}

export type WorkPart =
  | (WorkBase & { kind: 'file-read'; path: string; ranges?: { start: number; end: number }[] })
  | (WorkBase & { kind: 'file-edit'; path: string; diff?: string; added?: number; removed?: number })
  | (WorkBase & { kind: 'command-run'; command: string; cwd?: string; exitCode?: number; output?: string })
  | (WorkBase & { kind: 'tool-call'; name: string; input: unknown; result?: unknown });

export interface Provenance {
  filesSkipped: { path: string; reason: string }[];
  uncertainties: string[];
  complete: boolean; // did the adapter capture the whole trail?
}

// --- 2. Event stream (main -> renderer) ------------------------------------

export interface EventEnvelope {
  v: number; // CONTRACT_VERSION
  seq: number; // monotonic per conversation
  conversationId: ConversationId;
}

export type AgentEvent = EventEnvelope &
  (
    | { type: 'conversation.created'; conversation: Conversation }
    | { type: 'conversation.updated'; title?: string; updatedAt: number }
    | { type: 'entry.added'; entry: Entry }
    | { type: 'part.added'; entryId: EntryId; index: number; part: Part }
    | { type: 'text.appended'; entryId: EntryId; partId: PartId; delta: string }
    | { type: 'part.updated'; entryId: EntryId; partId: PartId; patch: PartPatch }
    | {
        type: 'entry.status';
        entryId: EntryId;
        status: Entry['status'];
        error?: { message: string };
      }
    | { type: 'provenance.updated'; entryId: EntryId; provenance: Provenance }
    | { type: 'permission.requested'; entryId: EntryId; partId: PartId; requestId: string }
    | { type: 'permission.resolved'; requestId: string; decision: PermissionDecision }
  );

// Shallow patch over a work part's mutable fields; id and kind cannot change.
export type PartPatch = Partial<Omit<WorkPart, 'id' | 'kind'>>;

// --- 3. Command surface (renderer -> main) and permission -------------------

export type PermissionDecision = { outcome: 'allow' } | { outcome: 'deny'; reason?: string };

export interface FractalAgentApi {
  // queries
  listConversations(): Promise<Conversation[]>;
  getConversation(
    id: ConversationId,
  ): Promise<{ conversation: Conversation; entries: Entry[]; seq: number } | null>;
  createConversation(): Promise<Conversation | null>;

  // turn control
  sendMessage(input: { conversationId: ConversationId; text: string }): Promise<{ entryId: EntryId }>;
  cancelTurn(input: { conversationId: ConversationId }): Promise<void>;

  // permission
  respondToPermission(input: { requestId: string; decision: PermissionDecision }): Promise<void>;

  // stream
  onAgentEvent(listener: (event: AgentEvent) => void): () => void; // returns unsubscribe
}

// --- runtime members ---------------------------------------------------

export const CONTRACT_VERSION = 1 as const;

export function isTextPart(part: Part): part is TextPart {
  return part.kind === 'text';
}

export function isWorkPart(part: Part): part is WorkPart {
  return (
    part.kind === 'file-read' ||
    part.kind === 'file-edit' ||
    part.kind === 'command-run' ||
    part.kind === 'tool-call'
  );
}

/** Derived, never stored (spec §1): read paths from an entry's file-read parts. */
export function filesReadFrom(entry: Entry): string[] {
  const seen = new Set<string>();
  for (const part of entry.parts) {
    if (part.kind === 'file-read') seen.add(part.path);
  }
  return [...seen];
}
