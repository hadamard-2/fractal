# Composer Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user attach images and files to a conversation message for both Claude and Codex, and see and open those attachments in the transcript.

**Architecture:** The renderer sends `{ text, attachments }` where each attachment is a disk path or pasted image bytes. The IPC layer resolves that into a list of on-disk files, sniffing which are images, and hands it to the adapter. Each adapter maps images to its native image input (Claude: base64 blocks on stdin via `--input-format stream-json`; Codex: `localImage` items) and non-images to a trailing `<attachments>` text block. In history, the turn projector strips that block back into `userMessage.attachments`. The renderer fetches previews lazily through a scoped `previewAttachment` IPC call that only serves paths listed in the open conversation's turns.

**Tech Stack:** Electron 43 (main, preload with `contextBridge` + `webUtils`), React 19, TypeScript 5.9, vitest 2 (node and jsdom environments), `@streamdown/code` for highlighting, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-09-28-composer-attachments-design.md`

## Global Constraints

- At most 10 attachments per message (`MAX_PROMPT_ATTACHMENTS = 10`).
- Images: PNG, JPEG, GIF, WebP only (`CONVERSATION_IMAGE_TYPES`); at most 20 MiB raw (`MAX_ATTACHMENT_IMAGE_BYTES = 20 * 1024 * 1024`).
- Text preview: first 256 KiB (`ATTACHMENT_PREVIEW_TEXT_BYTES = 256 * 1024`); a file is text if it decodes as UTF-8 and contains no NUL byte.
- Pasted images are written to `<userData>/attachments/<conversation-key>/<uuid>.<ext>`.
- Non-image block format, appended after a blank line, one absolute path per line: `<attachments>\n/abs/one\n/abs/two\n</attachments>`.
- `contextIsolation` stays on and `nodeIntegration` stays off; the renderer gets disk paths only through the preload helper.
- Normalizers and the turn projector never touch the filesystem.
- `AttachmentError` messages pass through the IPC error hiding unchanged; every other failure inside a call still becomes "Conversation operation failed".
- `pnpm lint`, `pnpm exec tsc --noEmit`, and `pnpm test` pass after every task.
- Commits use Conventional Commits (`feat(scope): subject`). Never `git push`.

## File Structure

Create:
- `src/main/attachments/sniff.ts`: image type from leading bytes.
- `src/main/attachments/resolve.ts`: `AttachmentError`, `resolveAttachments()` (write pasted bytes, stat and sniff paths).
- `src/main/attachments/preview.ts`: `readAttachmentPreview()`.
- `src/main/harness/attachment-block.ts`: `composePromptText()` and `splitAttachmentBlock()`, the two halves of the block format.
- `src/components/conversation/prompt-attachments.ts`: maps composer files to contract attachments; composer file validation.
- `src/components/conversation/attachment-preview-context.tsx`: provides preview/open bound to the open conversation, with a per-panel cache.
- `src/components/conversation/message-attachments.tsx`: transcript thumbnails, chips, and the preview dialog.
- Tests beside each (`*.test.ts` / `*.test.tsx`).

Modify:
- `src/shared/conversation-contract.ts`: new types, constants, API methods.
- `src/shared/conversation-ipc.ts`: `parsePromptInput`, attachment path/action parsers, `userMessage.attachments` validation, new channels.
- `src/main/harness/types.ts`: `ResolvedAttachment`, `AgentPrompt`.
- `src/main/harness/reconciler.ts`: `turn-started` payload gains `attachments`.
- `src/main/harness/turn-projector.ts`: strip the block into `userMessage.attachments`.
- `src/main/harness/codex/codex-normalizer.ts`: `localImage` becomes an image attachment.
- `src/main/harness/codex/codex-adapter.ts`: `turn/start` input mapping.
- `src/main/harness/claude/claude-runner.ts`: stdin stream-json input.
- `src/main/harness/claude/claude-adapter.ts`: compose text, read images.
- `src/main/conversation-service.ts`: `continue` takes `AgentPrompt`; `attachmentAllowed()`.
- `src/main/agent-ipc.ts`: resolve on continue; preview/open channels; `AttachmentError` pass-through; attachments root option.
- `src/main.ts`: pass the attachments root.
- `src/preload.ts`, `src/global.d.ts`: `attachments.pathFor`, preview/open methods.
- `src/components/ai-elements/prompt-input.tsx`: record disk paths; validation hook; skip conversion for pathed files.
- `src/renderer/use-conversation.ts`: `send(text, attachments?)`.
- `src/components/conversation-panel.tsx`: paperclip, chips, submit mapping, preview provider.
- `src/components/conversation/conversation-turn.tsx`: render `MessageAttachments`.
- `src/components/conversation/highlighted-command.tsx`: optional `language` prop.

---

### Task 1: Prompt and transcript contract

**Files:**
- Modify: `src/shared/conversation-contract.ts`
- Modify: `src/shared/conversation-ipc.ts`
- Test: `src/shared/conversation-contract.test.ts`, `src/shared/conversation-ipc.test.ts`

**Interfaces:**
- Produces (in `@/shared/conversation-contract`):
  - `MAX_PROMPT_ATTACHMENTS = 10`, `MAX_ATTACHMENT_IMAGE_BYTES = 20 * 1024 * 1024`, `MAX_ATTACHMENT_IMAGE_DATA_LENGTH`, `ATTACHMENT_PREVIEW_TEXT_BYTES = 256 * 1024`
  - `type ConversationImageType = (typeof CONVERSATION_IMAGE_TYPES)[number]`
  - `type PromptAttachment = { kind: 'path'; path: string } | { kind: 'bytes'; name: string; mediaType: ConversationImageType; data: string }`
  - `interface PromptInput { text: string; attachments?: PromptAttachment[] }`
  - `interface UserMessageAttachment { path: string; kind: 'image' | 'file' }`
  - `type AttachmentPreview = { kind: 'image'; image: ConversationImage; size: number; modifiedAt: number } | { kind: 'text'; text: string; truncated: boolean; size: number; modifiedAt: number } | { kind: 'binary'; size: number; modifiedAt: number } | { kind: 'missing' }`
  - `type AttachmentOpenAction = 'open' | 'reveal'`
  - `interface AttachmentsApi { pathFor(file: File): string }`
  - `ConversationTurn.userMessage.attachments?: UserMessageAttachment[]`
  - `ConversationApi.continue(ref, prompt: PromptInput)`, `previewAttachment(ref, path): Promise<AttachmentPreview>`, `openAttachment(ref, path, action: AttachmentOpenAction): Promise<void>`
- Produces (in `@/shared/conversation-ipc`): `parsePromptInput(value): PromptInput`, `parseAttachmentPath(value): string`, `parseAttachmentOpenAction(value): AttachmentOpenAction`, `CONVERSATION_CHANNELS.previewAttachment = 'fractal:conversations:preview-attachment'`, `CONVERSATION_CHANNELS.openAttachment = 'fractal:conversations:open-attachment'`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe` in `src/shared/conversation-contract.test.ts` that already tests `parsePromptInput` (keep its existing assertions for `'Prompt cannot be empty'` and `'Prompt is too large'`):

```ts
  test('accepts attachments with or without text and rejects malformed ones', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    expect(parsePromptInput({ text: 'Look', attachments: [{ kind: 'path', path: '/repo/a.ts' }] })).toEqual({ text: 'Look', attachments: [{ kind: 'path', path: '/repo/a.ts' }] });
    expect(parsePromptInput({ text: '', attachments: [{ kind: 'bytes', name: 'shot.png', mediaType: 'image/png', data: png }] })).toEqual({ text: '', attachments: [{ kind: 'bytes', name: 'shot.png', mediaType: 'image/png', data: png }] });
    expect(parsePromptInput({ text: 'Plain' })).toEqual({ text: 'Plain' });
    expect(() => parsePromptInput({ text: ' ', attachments: [] })).toThrow('Prompt cannot be empty');
    expect(() => parsePromptInput({ text: 'x', attachments: [{ kind: 'path', path: 'relative/a.ts' }] })).toThrow('Invalid prompt');
    expect(() => parsePromptInput({ text: 'x', attachments: [{ kind: 'bytes', name: 'a.svg', mediaType: 'image/svg+xml', data: png }] })).toThrow('Invalid prompt');
    expect(() => parsePromptInput({ text: 'x', attachments: [{ kind: 'bytes', name: 'a.png', mediaType: 'image/png', data: 'not base64!' }] })).toThrow('Invalid prompt');
    expect(() => parsePromptInput({ text: 'x', attachments: Array.from({ length: 11 }, () => ({ kind: 'path', path: '/repo/a.ts' })) })).toThrow('at most 10 attachments');
    expect(() => parsePromptInput({ text: 'x', attachments: [{ kind: 'bytes', name: 'big.png', mediaType: 'image/png', data: 'A'.repeat(MAX_ATTACHMENT_IMAGE_DATA_LENGTH + 4) }] })).toThrow('larger than 20 MiB');
  });

  test('parses attachment paths and open actions', () => {
    expect(parseAttachmentPath('/repo/a.ts')).toBe('/repo/a.ts');
    expect(() => parseAttachmentPath('a.ts')).toThrow('Invalid attachment path');
    expect(parseAttachmentOpenAction('reveal')).toBe('reveal');
    expect(() => parseAttachmentOpenAction('delete')).toThrow('Invalid attachment action');
  });
```

Add the new names to that file's imports: `parseAttachmentPath`, `parseAttachmentOpenAction` from `@/shared/conversation-ipc`, and `MAX_ATTACHMENT_IMAGE_DATA_LENGTH` from `@/shared/conversation-contract` (check which module the file already imports `parsePromptInput` from, and add these beside it).

Append inside `describe('native conversation event validation')` in `src/shared/conversation-ipc.test.ts`:

```ts
  test('accepts user message attachments and rejects relative paths or unknown kinds', () => {
    const attachments = [{ path: '/repo/notes.md', kind: 'file' as const }, { path: '/tmp/shot.png', kind: 'image' as const }];
    const withAttachments = { ...turn, userMessage: { ...turn.userMessage, attachments } };
    expect(parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'turn.upserted', turn: withAttachments })).toMatchObject({ turn: withAttachments });
    for (const bad of [[{ path: 'notes.md', kind: 'file' }], [{ path: '/repo/a', kind: 'video' }], { path: '/repo/a', kind: 'file' }]) {
      const turnWithBad = { ...turn, userMessage: { ...turn.userMessage, attachments: bad } };
      expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'turn.upserted', turn: turnWithBad })).toThrow('Invalid conversation stream event');
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/shared/conversation-contract.test.ts src/shared/conversation-ipc.test.ts`
Expected: FAIL. The new imports don't exist yet, and the attachment tests fail.

- [ ] **Step 3: Add the contract types**

In `src/shared/conversation-contract.ts`, directly after `MAX_CONVERSATION_IMAGE_DATA_LENGTH`:

```ts
export type ConversationImageType = (typeof CONVERSATION_IMAGE_TYPES)[number];
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
```

Change `ConversationImage.mediaType` to `mediaType: ConversationImageType;`.

Change `ConversationTurn.userMessage` to:

```ts
  userMessage: { id: string; text: string; createdAt?: number; images?: ConversationImage[]; attachments?: UserMessageAttachment[] };
```

In `ConversationApi`, replace the `continue` line and add two methods after `resolveRequest`:

```ts
  continue(ref: ConversationRef, prompt: PromptInput): Promise<void>;
```

```ts
  previewAttachment(ref: ConversationRef, path: string): Promise<AttachmentPreview>;
  openAttachment(ref: ConversationRef, path: string, action: AttachmentOpenAction): Promise<void>;
```

- [ ] **Step 4: Implement the parsers and channels**

In `src/shared/conversation-ipc.ts`:

Add to the contract import list: `MAX_ATTACHMENT_IMAGE_DATA_LENGTH`, `MAX_PROMPT_ATTACHMENTS`, `type AttachmentOpenAction`, `type ConversationImageType`, `type PromptAttachment`, `type PromptInput`, `type UserMessageAttachment`.

Add to `CONVERSATION_CHANNELS`:

```ts
  previewAttachment: 'fractal:conversations:preview-attachment', openAttachment: 'fractal:conversations:open-attachment',
```

Add below `MAX_HISTORY_TURNS`:

```ts
const MAX_ATTACHMENT_NAME_LENGTH = 1_024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
```

Add below `absolutePath`:

```ts
function imageType(value: unknown): value is ConversationImageType {
  return (CONVERSATION_IMAGE_TYPES as readonly unknown[]).includes(value);
}

function invalidPrompt(): never {
  throw new Error('Invalid prompt');
}
```

Replace `parsePromptInput` with:

```ts
export function parsePromptInput(value: unknown): PromptInput {
  if (!plainObject(value) || typeof value.text !== 'string') invalidPrompt();
  if (value.text.length > MAX_TEXT_LENGTH) throw new Error('Prompt is too large');
  const attachments = value.attachments === undefined ? [] : parsePromptAttachments(value.attachments);
  if (value.text.trim().length === 0 && attachments.length === 0) throw new Error('Prompt cannot be empty');
  return attachments.length > 0 ? { text: value.text, attachments } : { text: value.text };
}

function parsePromptAttachments(value: unknown): PromptAttachment[] {
  if (!denseArray(value)) invalidPrompt();
  if (value.length > MAX_PROMPT_ATTACHMENTS) throw new Error(`A message can carry at most ${MAX_PROMPT_ATTACHMENTS} attachments`);
  return value.map((item): PromptAttachment => {
    if (!plainObject(item)) invalidPrompt();
    if (item.kind === 'path') {
      if (!absolutePath(item.path)) invalidPrompt();
      return { kind: 'path', path: item.path };
    }
    if (item.kind === 'bytes') {
      if (typeof item.data === 'string' && item.data.length > MAX_ATTACHMENT_IMAGE_DATA_LENGTH) throw new Error('Pasted image is larger than 20 MiB');
      if (!nonblankText(item.name, MAX_ATTACHMENT_NAME_LENGTH) || !imageType(item.mediaType) || typeof item.data !== 'string' || !BASE64.test(item.data)) invalidPrompt();
      return { kind: 'bytes', name: item.name, mediaType: item.mediaType, data: item.data };
    }
    invalidPrompt();
  });
}

export function parseAttachmentPath(value: unknown): string {
  if (!absolutePath(value)) throw new Error('Invalid attachment path');
  return value;
}

export function parseAttachmentOpenAction(value: unknown): AttachmentOpenAction {
  if (value !== 'open' && value !== 'reveal') throw new Error('Invalid attachment action');
  return value;
}
```

In `cloneImages`, replace `(CONVERSATION_IMAGE_TYPES as readonly unknown[]).includes(image.mediaType)` with `imageType(image.mediaType)`, and the cast `image.mediaType as ConversationImage['mediaType']` with `image.mediaType`. Keep behaviour identical.

Add below `cloneImages`:

```ts
function cloneUserAttachments(value: unknown): { attachments?: UserMessageAttachment[] } {
  if (value === undefined) return {};
  return {
    attachments: mapDense(value, (item) => {
      if (!plainObject(item) || !absolutePath(item.path) || (item.kind !== 'image' && item.kind !== 'file')) invalidEvent();
      return { path: item.path, kind: item.kind };
    }),
  };
}
```

In `cloneTurn`, append `...cloneUserAttachments(value.userMessage.attachments)` after `...cloneImages(value.userMessage.images)` inside the `userMessage` object.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/shared/conversation-contract.test.ts src/shared/conversation-ipc.test.ts`
Expected: PASS.

Run: `pnpm exec tsc --noEmit`
Expected: errors only where `ConversationApi` is implemented or mocked without `previewAttachment`/`openAttachment`: `src/preload.ts` and test mocks such as `src/components/conversation-panel.test.tsx` and `src/renderer/use-conversation.test.tsx`. Fix the test mocks now by adding `previewAttachment: vi.fn(async () => ({ kind: 'missing' as const })), openAttachment: vi.fn(async () => undefined),` to each object literal typed `ConversationApi`. Leave `src/preload.ts` for Task 7, but add these two temporary lines to its `conversations` object so the build typechecks in between:

```ts
  previewAttachment: (ref, path) => ipcRenderer.invoke(CHANNELS.previewAttachment, ref, path),
  openAttachment: (ref, path, action) => ipcRenderer.invoke(CHANNELS.openAttachment, ref, path, action),
```

These are the final lines, not placeholders. Task 7 only adds the `attachments` object and the main-side handlers.

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared src/preload.ts src/components/conversation-panel.test.tsx src/renderer/use-conversation.test.tsx
git commit -m "feat(conversation): add the attachment prompt and transcript contract"
```

(Stage any other test file you had to touch in Step 5.)

---

### Task 2: Attachment block, Codex image history, and projection

**Files:**
- Create: `src/main/harness/attachment-block.ts`
- Test: `src/main/harness/attachment-block.test.ts`
- Modify: `src/main/harness/types.ts`
- Modify: `src/main/harness/reconciler.ts:11`
- Modify: `src/main/harness/turn-projector.ts` (`startTurn`)
- Modify: `src/main/harness/codex/codex-normalizer.ts` (`userMessage` case and `isThreadItem`)
- Test: `src/main/harness/turn-projector.test.ts`, `src/main/harness/codex/codex-normalizer.test.ts`

**Interfaces:**
- Consumes: `UserMessageAttachment`, `ConversationImageType` (Task 1).
- Produces (in `@/main/harness/types`): `interface ResolvedAttachment { path: string; image?: ConversationImageType }` and `interface AgentPrompt { text: string; attachments?: ResolvedAttachment[] }`. `image` is set only when main sniffed the file as a supported image.
- Produces (in `@/main/harness/attachment-block`): `composePromptText(prompt: AgentPrompt): string` and `splitAttachmentBlock(text: string): { text: string; paths: string[] }`.
- Produces: `NativeEventPayload` `turn-started` gains `attachments?: UserMessageAttachment[]`.

- [ ] **Step 1: Write the failing tests**

Create `src/main/harness/attachment-block.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { composePromptText, splitAttachmentBlock } from '@/main/harness/attachment-block';

describe('attachment block', () => {
  test('appends non-image paths after a blank line and leaves images out', () => {
    expect(composePromptText({ text: 'Review these', attachments: [{ path: '/repo/a.ts' }, { path: '/tmp/shot.png', image: 'image/png' }, { path: '/repo/b.log' }] }))
      .toBe('Review these\n\n<attachments>\n/repo/a.ts\n/repo/b.log\n</attachments>');
  });

  test('is the block alone without text, and the text alone without files', () => {
    expect(composePromptText({ text: '', attachments: [{ path: '/repo/a.ts' }] })).toBe('<attachments>\n/repo/a.ts\n</attachments>');
    expect(composePromptText({ text: 'Only text', attachments: [{ path: '/tmp/shot.png', image: 'image/png' }] })).toBe('Only text');
    expect(composePromptText({ text: 'Only text' })).toBe('Only text');
  });

  test('splits a trailing well-formed block back into text and paths', () => {
    expect(splitAttachmentBlock('Review these\n\n<attachments>\n/repo/a.ts\n/repo/b.log\n</attachments>')).toEqual({ text: 'Review these', paths: ['/repo/a.ts', '/repo/b.log'] });
    expect(splitAttachmentBlock('<attachments>\n/repo/a.ts\n</attachments>')).toEqual({ text: '', paths: ['/repo/a.ts'] });
  });

  test('leaves malformed, relative, or mid-message blocks as text', () => {
    for (const text of [
      'Review\n\n<attachments>\nrelative/a.ts\n</attachments>',
      'Review\n\n<attachments>\n/repo/a.ts\n</attachments>\n\nand more',
      'Review\n<attachments>\n/repo/a.ts\n</attachments>',
      'Review\n\n<attachments>\n</attachments>',
    ]) expect(splitAttachmentBlock(text)).toEqual({ text, paths: [] });
  });
});
```

Append to the `describe('projectTurns')` in `src/main/harness/turn-projector.test.ts`:

```ts
  test('moves a trailing attachment block into user message attachments after provider images', () => {
    const [turn] = projectTurns([
      event('u9', 1, { kind: 'turn-started', turnId: 't9', userMessageId: 'u9', text: 'Look\n\n<attachments>\n/repo/a.ts\n</attachments>', attachments: [{ path: '/tmp/shot.png', kind: 'image' }] }),
    ]);
    expect(turn.userMessage.text).toBe('Look');
    expect(turn.userMessage.attachments).toEqual([{ path: '/tmp/shot.png', kind: 'image' }, { path: '/repo/a.ts', kind: 'file' }]);
  });

  test('omits attachments when a user message has none', () => {
    const [turn] = projectTurns([event('u10', 1, { kind: 'turn-started', turnId: 't10', userMessageId: 'u10', text: 'Plain' })]);
    expect(turn.userMessage).not.toHaveProperty('attachments');
  });
```

Append to `describe('Codex native normalization')` in `src/main/harness/codex/codex-normalizer.test.ts`:

```ts
  test('records local images on the user message instead of reporting them unsupported', () => {
    const thread = structuredClone(threadRead.thread) as typeof threadRead.thread;
    (thread.turns[0].items[0] as { content: unknown[] }).content = [
      { type: 'text', text: 'What is this?', text_elements: [] },
      { type: 'localImage', path: '/tmp/shot.png' },
      { type: 'skill', name: 'review', path: '/skills/review' },
    ];
    const events = normalizeCodexThread(thread as never);
    expect(events[0].payload).toMatchObject({ kind: 'turn-started', text: 'What is this?', attachments: [{ path: '/tmp/shot.png', kind: 'image' }] });
    expect(events.filter((event) => event.payload.kind === 'unsupported').map((event) => event.nativeType)).toEqual(['skill']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/main/harness/attachment-block.test.ts src/main/harness/turn-projector.test.ts src/main/harness/codex/codex-normalizer.test.ts`
Expected: FAIL. The `attachment-block` module is missing, `attachments` isn't a known payload field, and `localImage` is reported as unsupported.

- [ ] **Step 3: Add the harness prompt types**

In `src/main/harness/types.ts`, add `ConversationImageType` to the contract import, and add:

```ts
/** An attachment resolved to a file on disk; image is set only when the file sniffs as a supported image. */
export interface ResolvedAttachment {
  path: string;
  image?: ConversationImageType;
}

export interface AgentPrompt {
  text: string;
  attachments?: ResolvedAttachment[];
}
```

Change `continueConversation(ref: ConversationRef, prompt: { text: string })` to `continueConversation(ref: ConversationRef, prompt: AgentPrompt)`.

- [ ] **Step 4: Implement the block**

Create `src/main/harness/attachment-block.ts`:

```ts
import type { AgentPrompt } from '@/main/harness/types';

const ABSOLUTE = /^(\/|\\|[A-Za-z]:[\\/])/;
const TRAILING_BLOCK = /(?:^|\n\n)<attachments>\n((?:[^\n]+\n)+)<\/attachments>$/;

/** The text an agent receives: the user's text, then non-image attachments as a trailing block of absolute paths. */
export function composePromptText(prompt: AgentPrompt): string {
  const files = (prompt.attachments ?? []).filter((attachment) => !attachment.image).map((attachment) => attachment.path);
  if (files.length === 0) return prompt.text;
  const block = ['<attachments>', ...files, '</attachments>'].join('\n');
  return prompt.text.trim() ? `${prompt.text}\n\n${block}` : block;
}

/** The inverse of composePromptText for a block at the very end of a message; anything else stays text. */
export function splitAttachmentBlock(text: string): { text: string; paths: string[] } {
  const match = TRAILING_BLOCK.exec(text);
  if (!match) return { text, paths: [] };
  const paths = match[1].slice(0, -1).split('\n');
  if (!paths.every((path) => ABSOLUTE.test(path))) return { text, paths: [] };
  return { text: text.slice(0, match.index), paths };
}
```

- [ ] **Step 5: Carry attachments through the payload, the projector, and the Codex normalizer**

In `src/main/harness/reconciler.ts`, add `UserMessageAttachment` to its contract type import and change the `turn-started` payload to:

```ts
  | { kind: 'turn-started'; turnId: string; userMessageId: string; text: string; createdAt?: number; images?: ConversationImage[]; attachments?: UserMessageAttachment[] }
```

In `src/main/harness/turn-projector.ts`, import `splitAttachmentBlock` from `@/main/harness/attachment-block`. In `startTurn`, replace the `userMessage` object with:

```ts
    const split = splitAttachmentBlock(payload.text);
    const attachments = [...(payload.attachments ?? []), ...split.paths.map((path) => ({ path, kind: 'file' as const }))];
```

(placed just before `this.current = {`) and:

```ts
      userMessage: {
        id: payload.userMessageId,
        text: split.text,
        ...(payload.createdAt === undefined ? {} : { createdAt: payload.createdAt }),
        ...(payload.images === undefined ? {} : { images: payload.images }),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
```

In `src/main/harness/codex/codex-normalizer.ts`, replace the `case 'userMessage'` body with:

```ts
    case 'userMessage': {
      const text = item.content.filter((content) => content.type === 'text').map((content) => content.text).join('\n');
      const attachments = item.content.flatMap((content) => content.type === 'localImage' ? [{ path: content.path, kind: 'image' as const }] : []);
      const unknown = item.content.flatMap((content, index) => content.type === 'text' || content.type === 'localImage' ? [] : [unsupported(`${item.id}:content:${index}`, content.type, observedAt, turnId)]);
      return [event(item.id, item.type, observedAt, { kind: 'turn-started', turnId, userMessageId: item.id, text, ...(attachments.length > 0 ? { attachments } : {}) }), ...unknown];
    }
```

In `isThreadItem`, change the `userMessage` case to also require a string path on `localImage`:

```ts
    case 'userMessage': return Array.isArray(value.content) && value.content.every((content) => isObject(content) && typeof content.type === 'string' && (content.type !== 'text' || typeof content.text === 'string') && (content.type !== 'localImage' || typeof content.path === 'string'));
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm exec vitest run src/main/harness`
Expected: PASS.

Run: `pnpm exec tsc --noEmit`
Expected: PASS. The adapters' `continueConversation(…, prompt: { text: string })` still satisfies `AgentPrompt` structurally for callers; Tasks 4 and 5 change the adapters themselves.

- [ ] **Step 7: Commit**

```bash
git add src/main/harness
git commit -m "feat(conversation): project attachment blocks and Codex images onto user messages"
```

---

### Task 3: Resolve attachments in main

**Files:**
- Create: `src/main/attachments/sniff.ts`, `src/main/attachments/resolve.ts`
- Test: `src/main/attachments/sniff.test.ts`, `src/main/attachments/resolve.test.ts`

**Interfaces:**
- Consumes: `PromptInput`, `ConversationRef`, `conversationKey`, `MAX_ATTACHMENT_IMAGE_BYTES` (Task 1); `AgentPrompt`, `ResolvedAttachment` (Task 2).
- Produces: `sniffImageType(bytes: Uint8Array): ConversationImageType | undefined`; `class AttachmentError extends Error`; `resolveAttachments(prompt: PromptInput, options: { root: string; ref: ConversationRef }): Promise<AgentPrompt>`. It returns `{ text }` with no `attachments` key when the prompt has none.

- [ ] **Step 1: Write the failing tests**

Create `src/main/attachments/sniff.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { sniffImageType } from '@/main/attachments/sniff';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('sniffImageType', () => {
  test('recognises the four supported signatures', () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif');
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe('image/webp');
  });

  test('rejects text, truncated headers, and RIFF files that are not WebP', () => {
    expect(sniffImageType(new TextEncoder().encode('export const a = 1;'))).toBeUndefined();
    expect(sniffImageType(bytes(0x89, 0x50))).toBeUndefined();
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45))).toBeUndefined();
  });
});
```

Create `src/main/attachments/resolve.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AttachmentError, resolveAttachments } from '@/main/attachments/resolve';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ref = { provider: 'claude' as const, nativeSessionId: 'session-1', projectPath: '/repo' };
let directory: string;
let root: string;

beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'fractal-attach-')); root = path.join(directory, 'attachments'); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('resolveAttachments', () => {
  test('passes a text-only prompt through without an attachments key', async () => {
    await expect(resolveAttachments({ text: 'Hi' }, { root, ref })).resolves.toEqual({ text: 'Hi' });
  });

  test('writes pasted bytes under the conversation folder and marks them by sniffed type', async () => {
    const result = await resolveAttachments({ text: '', attachments: [{ kind: 'bytes', name: 'shot.png', mediaType: 'image/jpeg', data: PNG.toString('base64') }] }, { root, ref });
    const [attachment] = result.attachments ?? [];
    expect(attachment.image).toBe('image/png');
    expect(path.dirname(attachment.path)).toBe(path.join(root, 'claude_session-1'));
    expect(attachment.path.endsWith('.png')).toBe(true);
    expect(await readFile(attachment.path)).toEqual(PNG);
  });

  test('rejects pasted bytes that are not a supported image', async () => {
    await expect(resolveAttachments({ text: '', attachments: [{ kind: 'bytes', name: 'shot.png', mediaType: 'image/png', data: Buffer.from('hello').toString('base64') }] }, { root, ref }))
      .rejects.toThrow(new AttachmentError('shot.png is not a PNG, JPEG, GIF, or WebP image'));
    await expect(readdir(root)).rejects.toThrow();
  });

  test('keeps disk paths in place, sniffing images and leaving other files unmarked', async () => {
    const image = path.join(directory, 'diagram.png'); const notes = path.join(directory, 'notes.md');
    await writeFile(image, PNG); await writeFile(notes, '# Notes');
    const result = await resolveAttachments({ text: 'Look', attachments: [{ kind: 'path', path: notes }, { kind: 'path', path: image }] }, { root, ref });
    expect(result).toEqual({ text: 'Look', attachments: [{ path: notes }, { path: image, image: 'image/png' }] });
  });

  test('names the file when a path is missing or is a directory', async () => {
    const missing = path.join(directory, 'gone.ts'); const folder = path.join(directory, 'folder');
    await mkdir(folder);
    await expect(resolveAttachments({ text: 'x', attachments: [{ kind: 'path', path: missing }] }, { root, ref })).rejects.toThrow(`${missing} no longer exists or cannot be read`);
    await expect(resolveAttachments({ text: 'x', attachments: [{ kind: 'path', path: folder }] }, { root, ref })).rejects.toThrow(`${folder} is not a file`);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/main/attachments`
Expected: FAIL. The modules are missing.

- [ ] **Step 3: Implement the sniffer**

Create `src/main/attachments/sniff.ts`:

```ts
import type { ConversationImageType } from '@/shared/conversation-contract';

/** The supported image type a file's leading bytes declare, if any; the renderer's claimed type is never trusted. */
export function sniffImageType(bytes: Uint8Array): ConversationImageType | undefined {
  const starts = (signature: readonly number[], offset = 0) =>
    bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return undefined;
}
```

- [ ] **Step 4: Implement resolution**

Create `src/main/attachments/resolve.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sniffImageType } from '@/main/attachments/sniff';
import type { AgentPrompt, ResolvedAttachment } from '@/main/harness/types';
import { conversationKey, MAX_ATTACHMENT_IMAGE_BYTES, type ConversationImageType, type ConversationRef, type PromptAttachment, type PromptInput } from '@/shared/conversation-contract';

/** A problem with a specific attachment; its message names the file and is shown to the user as-is. */
export class AttachmentError extends Error {
  override name = 'AttachmentError';
}

const EXTENSIONS: Record<ConversationImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const SNIFF_BYTES = 16;

export async function resolveAttachments(prompt: PromptInput, options: { root: string; ref: ConversationRef }): Promise<AgentPrompt> {
  if (!prompt.attachments?.length) return { text: prompt.text };
  const attachments: ResolvedAttachment[] = [];
  for (const attachment of prompt.attachments) {
    attachments.push(attachment.kind === 'bytes' ? await writePasted(attachment, options) : await inspectPath(attachment.path));
  }
  return { text: prompt.text, attachments };
}

async function writePasted(attachment: Extract<PromptAttachment, { kind: 'bytes' }>, { root, ref }: { root: string; ref: ConversationRef }): Promise<ResolvedAttachment> {
  const bytes = Buffer.from(attachment.data, 'base64');
  const image = sniffImageType(bytes);
  if (!image) throw new AttachmentError(`${attachment.name} is not a PNG, JPEG, GIF, or WebP image`);
  if (bytes.length > MAX_ATTACHMENT_IMAGE_BYTES) throw new AttachmentError(`${attachment.name} is larger than 20 MiB`);
  const directory = path.join(root, conversationKey(ref).replace(/[^A-Za-z0-9._-]/g, '_'));
  const file = path.join(directory, `${randomUUID()}.${EXTENSIONS[image]}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(file, bytes, { flag: 'wx' });
  } catch {
    throw new AttachmentError(`Could not save ${attachment.name}`);
  }
  return { path: file, image };
}

async function inspectPath(file: string): Promise<ResolvedAttachment> {
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new AttachmentError(`${file} is not a file`);
    size = info.size;
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError(`${file} no longer exists or cannot be read`);
  }
  let image: ConversationImageType | undefined;
  try {
    const handle = await open(file, 'r');
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(SNIFF_BYTES), 0, SNIFF_BYTES, 0);
      image = sniffImageType(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    throw new AttachmentError(`${file} cannot be read`);
  }
  if (image && size > MAX_ATTACHMENT_IMAGE_BYTES) throw new AttachmentError(`${path.basename(file)} is larger than 20 MiB`);
  return image ? { path: file, image } : { path: file };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/main/attachments && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/attachments
git commit -m "feat(attachments): resolve pasted images and attached paths in main"
```

---

### Task 4: Codex wire mapping

**Files:**
- Modify: `src/main/harness/codex/codex-adapter.ts` (`continueConversation`, the `turn/start` call)
- Test: `src/main/harness/codex/codex-adapter.test.ts`

**Interfaces:**
- Consumes: `AgentPrompt` (Task 2), `composePromptText` (Task 2).
- Produces: `continueConversation(ref, prompt: AgentPrompt)` sends `input`: a text item when the composed text is non-empty, then one `localImage` per image attachment in order.

- [ ] **Step 1: Write the failing test**

Append beside the existing `turn/start` test (around line 213) in `src/main/harness/codex/codex-adapter.test.ts`:

```ts
  test('sends images as localImage items and other files as a trailing attachments block', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    const run = await adapter.continueConversation(ref, { text: 'Compare', attachments: [{ path: '/repo/a.ts' }, { path: '/tmp/shot.png', image: 'image/png' }] });
    expect(server.requests.at(-1)).toEqual({ method: 'turn/start', params: { threadId: 'thread-1', input: [
      { type: 'text', text: 'Compare\n\n<attachments>\n/repo/a.ts\n</attachments>', text_elements: [] },
      { type: 'localImage', path: '/tmp/shot.png' },
    ] } });
    await run.dispose();
  });

  test('omits the text item for an image-only message', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    const run = await adapter.continueConversation(ref, { text: '', attachments: [{ path: '/tmp/shot.png', image: 'image/png' }] });
    expect(server.requests.at(-1)).toEqual({ method: 'turn/start', params: { threadId: 'thread-1', input: [{ type: 'localImage', path: '/tmp/shot.png' }] } });
    await run.dispose();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/main/harness/codex/codex-adapter.test.ts`
Expected: FAIL. The input contains only the raw text item.

- [ ] **Step 3: Implement the mapping**

In `src/main/harness/codex/codex-adapter.ts`, import `composePromptText` from `@/main/harness/attachment-block`, `type AgentPrompt` from `@/main/harness/types`, and `type UserInput` from `@/main/harness/codex/generated/v2/UserInput`. Change the signature to `async continueConversation(ref: ConversationRef, prompt: AgentPrompt): Promise<ConversationRun>`, and replace the `input:` line in the `turn/start` request with `input: codexTurnInput(prompt),`. Add at module level:

```ts
function codexTurnInput(prompt: AgentPrompt): UserInput[] {
  const text = composePromptText(prompt);
  return [
    ...(text ? [{ type: 'text' as const, text, text_elements: [] }] : []),
    ...(prompt.attachments ?? []).flatMap((attachment) => attachment.image ? [{ type: 'localImage' as const, path: attachment.path }] : []),
  ];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/main/harness/codex && pnpm exec tsc --noEmit`
Expected: PASS, including the existing `{ text: 'Continue the fix' }` test, which still produces a single text item.

- [ ] **Step 5: Commit**

```bash
git add src/main/harness/codex
git commit -m "feat(codex): send attachments as localImage items and a path block"
```

---

### Task 5: Claude stdin input

**Files:**
- Modify: `src/main/harness/claude/claude-runner.ts`
- Modify: `src/main/harness/claude/claude-adapter.ts` (`continueConversation`)
- Test: `src/main/harness/claude/claude-runner.test.ts`, `src/main/harness/claude/claude-adapter.test.ts`

**Interfaces:**
- Consumes: `AgentPrompt`, `composePromptText` (Task 2); `ConversationImage` (Task 1).
- Produces: `RunClaudeTurnOptions.prompt: { text: string; images?: ConversationImage[] }`, where `text` is the composed text and the runner's turn anchor compares against it; `claudeStdinMessage(prompt): string`; `ClaudeChildProcess.stdin`; spawn `stdio: ['pipe', 'pipe', 'pipe']`.

Spike finding this task relies on (spec, "Spike findings"): Claude Code 2.1.263 accepts `--resume <id> --print --input-format stream-json` with one user message on stdin holding a text block then base64 image blocks, and records the content array verbatim. The normalizer's `turn-started` text is then the single text block, so anchoring on the composed text is correct.

- [ ] **Step 1: Write the failing tests**

In `src/main/harness/claude/claude-runner.test.ts`, give `fakeProcess` a stdin. Add `const stdin = new PassThrough();` beside `stdout`, include `stdin` in the `Object.assign` object, and add `stdin: PassThrough` to the function's return type. Add this helper below `collect`:

```ts
function stdinText(child: { stdin: PassThrough }): string { return child.stdin.read()?.toString() ?? ''; }
```

Replace the test `'spawns resume as an exact argument array without a shell'` with:

```ts
  test('spawns resume without a shell and writes the prompt to stdin as one stream-json user message', async () => {
    const child = fakeProcess();
    const spawnProcess = vi.fn(() => child);
    const run = runClaudeTurn({ ref, prompt: { text: 'fix; $(touch /tmp/nope)' }, executable: '/usr/bin/claude', spawnProcess, permissionBridge: bridge, rereadNative: async () => [] });
    expect(JSON.parse(stdinText(child))).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'fix; $(touch /tmp/nope)' }] } });
    child.finish(); await collect(run.events);
    expect(spawnProcess).toHaveBeenCalledWith('/usr/bin/claude', [
      '--resume', 'claude-session-1', '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--mcp-config', '/tmp/bridge.json', '--permission-prompt-tool', 'fractal_permission',
    ], { cwd: '/work/fractal', shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  });

  test('puts image blocks after the text and drops an empty text block', async () => {
    const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' };
    const withText = fakeProcess();
    const first = runClaudeTurn({ ref, prompt: { text: 'What is this?', images: [image] }, executable: 'claude', spawnProcess: () => withText, rereadNative: async () => [] });
    expect(JSON.parse(stdinText(withText)).message.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
    withText.finish(); await collect(first.events);
    const imageOnly = fakeProcess();
    const second = runClaudeTurn({ ref, prompt: { text: '', images: [image] }, executable: 'claude', spawnProcess: () => imageOnly, rereadNative: async () => [] });
    expect(JSON.parse(stdinText(imageOnly)).message.content.map((block: { type: string }) => block.type)).toEqual(['image']);
    imageOnly.finish(); await collect(second.events);
  });
```

In `src/main/harness/claude/claude-adapter.test.ts`, add after the bridge-routing test (reuse that file's `root`, `ref`, `realpath`, `available`; import `mkdtemp`, `writeFile`, `rm` from `node:fs/promises` and `tmpdir` from `node:os` if not already imported):

```ts
  test('composes the attachment block and reads images into the runner prompt', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-attach-'));
    const image = path.join(directory, 'shot.png');
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const runTurn = vi.fn((): ClaudeTurnRun => ({ events: (async function* () { yield* [] as NativeEvent[]; })(), completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined) }));
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => ({ ...available, capabilities: { ...available.capabilities, approvals: false, questions: false } }), runtime: async () => 'idle', runTurn });
    const run = await adapter.continueConversation(ref, { text: 'Compare', attachments: [{ path: '/repo/a.ts' }, { path: image, image: 'image/png' }] });
    expect(runTurn.mock.calls[0][0].prompt).toEqual({
      text: 'Compare\n\n<attachments>\n/repo/a.ts\n</attachments>',
      images: [{ mediaType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64') }],
    });
    await run.dispose(); await rm(directory, { recursive: true, force: true });
  });
```

If `runTurn.mock.calls[0][0]` is typed as `never` because `vi.fn` was declared without parameters, declare it as `vi.fn((_options: RunClaudeTurnOptions): ClaudeTurnRun => …)` and import `type RunClaudeTurnOptions` from `./claude-runner`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/main/harness/claude`
Expected: FAIL. The runner still passes the prompt as an argument, and the adapter passes the raw prompt through.

- [ ] **Step 3: Implement stdin input in the runner**

In `src/main/harness/claude/claude-runner.ts`:

Add `type ConversationImage` to the contract import. Add to `ClaudeChildProcess`:

```ts
  readonly stdin: { end(chunk: string): unknown; on(event: 'error', listener: (error: Error) => void): unknown };
```

Change `ClaudeSpawnOptions` to `stdio: ['pipe', 'pipe', 'pipe']` and `RunClaudeTurnOptions.prompt` to:

```ts
  /** text is the composed prompt (user text plus any attachment block); the turn anchor matches it exactly. */
  prompt: { text: string; images?: ConversationImage[] };
```

Replace the `args` array with:

```ts
  const args = [
    ...sessionArguments, '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', ...bridgeArguments,
  ];
```

Change the spawn options to `{ cwd: options.ref.projectPath, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }`, and directly after the `const child = …` statement add:

```ts
  // A process that exits or fails to launch before reading stdin reports through close/error, not here.
  child.stdin.on('error', () => undefined);
  child.stdin.end(claudeStdinMessage(options.prompt));
```

Add at module level:

```ts
/** One stream-json user message: the text block (omitted when empty) followed by base64 image blocks. */
export function claudeStdinMessage(prompt: RunClaudeTurnOptions['prompt']): string {
  const content = [
    ...(prompt.text ? [{ type: 'text', text: prompt.text }] : []),
    ...(prompt.images ?? []).map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })),
  ];
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}
```

`spawnClaude` keeps returning `spawn(file, args, options) as ChildProcessWithoutNullStreams`; its `stdin` is a `Writable` and satisfies the new member.

- [ ] **Step 4: Compose text and read images in the adapter**

In `src/main/harness/claude/claude-adapter.ts`, import `composePromptText` from `@/main/harness/attachment-block`, `type AgentPrompt` from `@/main/harness/types`, `type ConversationImage` from the contract, and `readFile` from `node:fs/promises` (add it to an existing `node:fs/promises` import if there is one). Change the signature to `async continueConversation(input: ConversationRef, prompt: AgentPrompt): Promise<ConversationRun>`. Directly after the line that throws `'Conversation is not idle'`, add:

```ts
    const images = await readPromptImages(prompt);
    const turnPrompt = { text: composePromptText(prompt), ...(images.length > 0 ? { images } : {}) };
```

In the `runTurn` call, replace `prompt,` in the options object with `prompt: turnPrompt,`. Add at module level:

```ts
async function readPromptImages(prompt: AgentPrompt): Promise<ConversationImage[]> {
  return Promise.all((prompt.attachments ?? []).flatMap((attachment) => attachment.image
    ? [readFile(attachment.path).then((bytes) => ({ mediaType: attachment.image!, data: bytes.toString('base64') }))]
    : []));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/main/harness/claude && pnpm exec tsc --noEmit`
Expected: PASS. The anchor tests that write a `user` record whose content equals `prompt.text` still anchor, because `text` is unchanged for text-only prompts.

- [ ] **Step 6: Commit**

```bash
git add src/main/harness/claude
git commit -m "feat(claude): send prompts over stdin with native image blocks"
```

---

### Task 6: Attachment preview reader

**Files:**
- Create: `src/main/attachments/preview.ts`
- Test: `src/main/attachments/preview.test.ts`

**Interfaces:**
- Consumes: `sniffImageType` (Task 3); `AttachmentPreview`, `ATTACHMENT_PREVIEW_TEXT_BYTES`, `MAX_ATTACHMENT_IMAGE_BYTES` (Task 1).
- Produces: `readAttachmentPreview(file: string): Promise<AttachmentPreview>`. It never throws for a missing file. It throws for a file that exists but can't be opened, which the IPC layer reports as a generic failure.

- [ ] **Step 1: Write the failing test**

Create `src/main/attachments/preview.test.ts`:

```ts
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readAttachmentPreview } from '@/main/attachments/preview';
import { ATTACHMENT_PREVIEW_TEXT_BYTES } from '@/shared/conversation-contract';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'fractal-preview-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('readAttachmentPreview', () => {
  test('returns text with size and modification time', async () => {
    const file = path.join(directory, 'a.ts');
    await writeFile(file, 'export const a = 1;\n');
    const info = await stat(file);
    await expect(readAttachmentPreview(file)).resolves.toEqual({ kind: 'text', text: 'export const a = 1;\n', truncated: false, size: info.size, modifiedAt: info.mtimeMs });
  });

  test('truncates long text at the cap without breaking a multibyte character', async () => {
    const file = path.join(directory, 'long.txt');
    await writeFile(file, `${'a'.repeat(ATTACHMENT_PREVIEW_TEXT_BYTES - 1)}é and more`);
    const preview = await readAttachmentPreview(file);
    expect(preview).toMatchObject({ kind: 'text', truncated: true });
    expect(preview.kind === 'text' && preview.text).toBe('a'.repeat(ATTACHMENT_PREVIEW_TEXT_BYTES - 1));
  });

  test('returns images as base64 and non-UTF-8 or NUL-containing files as binary', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    await writeFile(path.join(directory, 'a.png'), png);
    await writeFile(path.join(directory, 'nul.bin'), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(path.join(directory, 'latin1.txt'), Buffer.from([0xe9, 0x61]));
    await expect(readAttachmentPreview(path.join(directory, 'a.png'))).resolves.toMatchObject({ kind: 'image', image: { mediaType: 'image/png', data: png.toString('base64') } });
    await expect(readAttachmentPreview(path.join(directory, 'nul.bin'))).resolves.toMatchObject({ kind: 'binary', size: 3 });
    await expect(readAttachmentPreview(path.join(directory, 'latin1.txt'))).resolves.toMatchObject({ kind: 'binary' });
  });

  test('reports a missing file as missing and a directory as binary', async () => {
    await expect(readAttachmentPreview(path.join(directory, 'gone.ts'))).resolves.toEqual({ kind: 'missing' });
    await mkdir(path.join(directory, 'folder'));
    await expect(readAttachmentPreview(path.join(directory, 'folder'))).resolves.toMatchObject({ kind: 'binary' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/main/attachments/preview.test.ts`
Expected: FAIL. The module is missing.

- [ ] **Step 3: Implement the reader**

Create `src/main/attachments/preview.ts`:

```ts
import { open, stat } from 'node:fs/promises';
import { sniffImageType } from '@/main/attachments/sniff';
import { ATTACHMENT_PREVIEW_TEXT_BYTES, MAX_ATTACHMENT_IMAGE_BYTES, type AttachmentPreview } from '@/shared/conversation-contract';

/** The file as it is now: an image, the leading text, or only its size when it is neither. */
export async function readAttachmentPreview(file: string): Promise<AttachmentPreview> {
  let info;
  try { info = await stat(file); } catch { return { kind: 'missing' }; }
  const meta = { size: info.size, modifiedAt: info.mtimeMs };
  if (!info.isFile()) return { kind: 'binary', ...meta };
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(info.size, ATTACHMENT_PREVIEW_TEXT_BYTES));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const sample = head.subarray(0, bytesRead);
    const image = sniffImageType(sample);
    if (image) {
      if (info.size > MAX_ATTACHMENT_IMAGE_BYTES) return { kind: 'binary', ...meta };
      return { kind: 'image', image: { mediaType: image, data: (await handle.readFile()).toString('base64') }, ...meta };
    }
    const truncated = info.size > ATTACHMENT_PREVIEW_TEXT_BYTES;
    const text = decodeText(sample, truncated);
    return text === undefined ? { kind: 'binary', ...meta } : { kind: 'text', text, truncated, ...meta };
  } finally {
    await handle.close();
  }
}

function decodeText(bytes: Buffer, truncated: boolean): string | undefined {
  if (bytes.includes(0)) return undefined;
  // stream: a character cut by truncation is held back instead of failing the whole decode.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated }); } catch { return undefined; }
}
```

Note: `handle.readFile()` reads from the current file position. After a positional `read` (explicit position `0`), the position is still `0`, so it reads the whole file. If the image test fails with truncated data, replace that call with `readFile(file)` from `node:fs/promises`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/main/attachments && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/attachments
git commit -m "feat(attachments): read attachment previews in main"
```

---

### Task 7: IPC wiring, service allow-list, and preload

**Files:**
- Modify: `src/main/conversation-service.ts` (`continue` signature; new `attachmentAllowed`)
- Modify: `src/main/agent-ipc.ts`
- Modify: `src/main.ts:230`
- Modify: `src/preload.ts`, `src/global.d.ts`
- Test: `src/main/conversation-service.test.ts`, `src/main/agent-ipc.test.ts`

**Interfaces:**
- Consumes: `resolveAttachments`, `AttachmentError` (Task 3); `readAttachmentPreview` (Task 6); `parseAttachmentPath`, `parseAttachmentOpenAction`, channels (Task 1); `AgentPrompt` (Task 2).
- Produces: `ConversationService.continue(ref, prompt: AgentPrompt, rendererId)`; `ConversationService.attachmentAllowed(ref: ConversationRef, path: string): boolean`; `registerConversationIpc(service, getWindow, options: { attachmentsRoot: string })`; `window.fractal.attachments.pathFor(file)`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('ConversationService')` in `src/main/conversation-service.test.ts`:

```ts
  test('allows only attachment paths recorded on the open conversation', async () => {
    const f = fixture([
      event('start:a', { kind: 'turn-started', turnId: 'a', userMessageId: 'user:a', text: 'Look\n\n<attachments>\n/repo/notes.md\n</attachments>', attachments: [{ path: '/tmp/shot.png', kind: 'image' }] }),
      finish('a'),
    ]);
    expect(f.service.attachmentAllowed(ref, '/repo/notes.md')).toBe(false);
    await f.service.open(ref, loadId);
    expect(f.service.attachmentAllowed(ref, '/repo/notes.md')).toBe(true);
    expect(f.service.attachmentAllowed(ref, '/tmp/shot.png')).toBe(true);
    expect(f.service.attachmentAllowed(ref, '/etc/passwd')).toBe(false);
    expect(f.service.attachmentAllowed({ ...ref, projectPath: '/other' }, '/repo/notes.md')).toBe(false);
    await f.service.dispose();
  });
```

In `src/main/agent-ipc.test.ts`:

1. Extend the hoisted mock and the `electron` mock:

```ts
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  picker: vi.fn(),
  openPath: vi.fn(async () => ''),
  showItemInFolder: vi.fn(),
}));
```

and add `shell: { openPath: electron.openPath, showItemInFolder: electron.showItemInFolder },` to the object returned by `vi.mock('electron', …)`.

2. Mock the attachment modules below the electron mock:

```ts
const attachments = vi.hoisted(() => ({
  resolve: vi.fn(async (prompt: { text: string }) => ({ text: prompt.text })),
  preview: vi.fn(async () => ({ kind: 'missing' as const })),
}));
vi.mock('@/main/attachments/resolve', async (actual) => ({ ...(await actual<typeof import('@/main/attachments/resolve')>()), resolveAttachments: attachments.resolve }));
vi.mock('@/main/attachments/preview', () => ({ readAttachmentPreview: attachments.preview }));
```

3. In `fixture()`, add `attachmentAllowed: vi.fn((_ref: unknown, path: string) => path === '/repo/notes.md'),` to `service`, and change `register` to pass `{ attachmentsRoot: '/data/attachments' }` as the third argument.

4. In the test that asserts the exact channel list (around line 86), add `'preview-attachment', 'open-attachment'` to the names array.

5. Add tests:

```ts
  test('resolves attachments before continuing and surfaces attachment errors by name', async () => {
    const f = fixture();
    await f.invoke('open', ref, loadId);
    attachments.resolve.mockResolvedValueOnce({ text: 'Go', attachments: [{ path: '/repo/a.ts' }] } as never);
    await f.invoke('continue', ref, { text: 'Go', attachments: [{ kind: 'path', path: '/repo/a.ts' }] });
    expect(attachments.resolve).toHaveBeenLastCalledWith({ text: 'Go', attachments: [{ kind: 'path', path: '/repo/a.ts' }] }, { root: '/data/attachments', ref });
    expect(f.service.continue).toHaveBeenLastCalledWith(ref, { text: 'Go', attachments: [{ path: '/repo/a.ts' }] }, '41');
    const { AttachmentError } = await import('@/main/attachments/resolve');
    attachments.resolve.mockRejectedValueOnce(new AttachmentError('/repo/gone.ts no longer exists or cannot be read'));
    await expect(f.invoke('continue', ref, { text: 'Go', attachments: [{ kind: 'path', path: '/repo/gone.ts' }] })).rejects.toThrow('/repo/gone.ts no longer exists or cannot be read');
    attachments.resolve.mockRejectedValueOnce(new Error('EACCES secret detail'));
    await expect(f.invoke('continue', ref, { text: 'Go', attachments: [{ kind: 'path', path: '/repo/x.ts' }] })).rejects.toThrow('Conversation operation failed');
  });

  test('previews and opens only attachments of an owned conversation', async () => {
    const f = fixture();
    await expect(f.invoke('preview-attachment', ref, '/repo/notes.md')).rejects.toThrow('Conversation is not owned by this renderer');
    await f.invoke('open', ref, loadId);
    await expect(f.invoke('preview-attachment', ref, '/repo/notes.md')).resolves.toEqual({ kind: 'missing' });
    expect(attachments.preview).toHaveBeenLastCalledWith('/repo/notes.md');
    await expect(f.invoke('preview-attachment', ref, '/etc/passwd')).rejects.toThrow('Attachment is not part of this conversation');
    await expect(f.invoke('preview-attachment', ref, 'relative.md')).rejects.toThrow('Invalid attachment path');
    await f.invoke('open-attachment', ref, '/repo/notes.md', 'reveal');
    expect(electron.showItemInFolder).toHaveBeenCalledWith('/repo/notes.md');
    await f.invoke('open-attachment', ref, '/repo/notes.md', 'open');
    expect(electron.openPath).toHaveBeenCalledWith('/repo/notes.md');
    await expect(f.invoke('open-attachment', ref, '/etc/passwd', 'open')).rejects.toThrow('Attachment is not part of this conversation');
    await expect(f.invoke('open-attachment', ref, '/repo/notes.md', 'delete')).rejects.toThrow('Invalid attachment action');
  });
```

If the existing `open` test flow requires a `history.complete` emit before other calls succeed, copy the minimal open sequence from the existing `continue` test (line ~120) instead of the bare `f.invoke('open', ref, loadId)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/main/conversation-service.test.ts src/main/agent-ipc.test.ts`
Expected: FAIL. `attachmentAllowed` and the new channels don't exist yet.

- [ ] **Step 3: Implement the service allow-list**

In `src/main/conversation-service.ts`, import `type AgentPrompt` from `@/main/harness/types`, change `continue(input: ConversationRef, prompt: { text: string }, rendererId: string)` to take `prompt: AgentPrompt`, and add after `close`:

```ts
  /** Whether a path is an attachment on a user message of this open conversation; the only files the preview may read. */
  attachmentAllowed(input: ConversationRef, file: string): boolean {
    const ref = parseConversationRef(input);
    const load = this.loads.get(conversationKey(ref));
    if (!load || load.ref.projectPath !== ref.projectPath) return false;
    for (const turn of load.turns.values()) {
      if (turn.userMessage.attachments?.some((attachment) => attachment.path === file)) return true;
    }
    return false;
  }
```

- [ ] **Step 4: Implement the IPC channels**

In `src/main/agent-ipc.ts`:

Change the electron import to `import { BrowserWindow, dialog, ipcMain, shell } from 'electron';`. Import `AttachmentError, resolveAttachments` from `@/main/attachments/resolve`, `readAttachmentPreview` from `@/main/attachments/preview`, and add `parseAttachmentOpenAction, parseAttachmentPath` to the `@/shared/conversation-ipc` import.

Change the signature to:

```ts
export function registerConversationIpc(service: ConversationService, getWindow: () => BrowserWindow | null, options: { attachmentsRoot: string }): Registration {
```

In `invoke`, replace `catch { throw new Error('Conversation operation failed'); }` with:

```ts
      catch (error) {
        // Attachment problems name the user's own file and are safe to show; everything else stays hidden.
        if (error instanceof AttachmentError) throw error;
        throw new Error('Conversation operation failed');
      }
```

and update the comment above it to: `// Parsing, ownership, and attachment errors are locally authored; native failures are hidden.`

Replace the `CHANNELS.continue` registration with:

```ts
    invoke(CHANNELS.continue, 2, ([input, promptInput], owner) => {
      const ref = parseConversationRef(input), prompt = parsePromptInput(promptInput); requireLoad(owner, ref);
      return async () => service.continue(ref, await resolveAttachments(prompt, { root: options.attachmentsRoot, ref }), String(owner.sender.id));
    });
```

Add after the `CHANNELS.resolveRequest` registration:

```ts
    const requireAttachment = (owner: Owner, input: unknown, pathInput: unknown) => {
      const ref = parseConversationRef(input), file = parseAttachmentPath(pathInput); requireLoad(owner, ref);
      if (!service.attachmentAllowed(ref, file)) throw new Error('Attachment is not part of this conversation');
      return file;
    };
    invoke(CHANNELS.previewAttachment, 2, ([input, pathInput], owner) => {
      const file = requireAttachment(owner, input, pathInput);
      return () => readAttachmentPreview(file);
    });
    invoke(CHANNELS.openAttachment, 3, ([input, pathInput, actionInput], owner) => {
      const action = parseAttachmentOpenAction(actionInput), file = requireAttachment(owner, input, pathInput);
      return async () => {
        if (action === 'reveal') { shell.showItemInFolder(file); return; }
        const failure = await shell.openPath(file);
        if (failure) throw new AttachmentError(`Could not open ${file}: ${failure}`);
      };
    });
```

- [ ] **Step 5: Wire main and preload**

In `src/main.ts`, change the registration line to:

```ts
    const registration = registerConversationIpc(conversationService, () => mainWindowRef, { attachmentsRoot: path.join(app.getPath('userData'), 'attachments') });
```

In `src/preload.ts`, change the electron import to `import { contextBridge, ipcRenderer, webUtils } from 'electron';`, change the contract type import to `import type { AttachmentsApi, ConversationApi } from '@/shared/conversation-contract';`, add:

```ts
const attachments: AttachmentsApi = {
  pathFor: (file) => webUtils.getPathForFile(file),
};
```

and change the last line to `contextBridge.exposeInMainWorld('fractal', { conversations, settings, terminals, attachments });`. (`previewAttachment` and `openAttachment` were added to `conversations` in Task 1.)

In `src/global.d.ts`, change the type import to include `AttachmentsApi`, and add `attachments: AttachmentsApi;` to `Window.fractal`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/main && pnpm exec tsc --noEmit && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main src/main.ts src/preload.ts src/global.d.ts
git commit -m "feat(conversation): resolve attachments over IPC and serve scoped previews"
```

---

### Task 8: Composer attachments

**Files:**
- Modify: `src/components/ai-elements/prompt-input.tsx`
- Create: `src/components/conversation/prompt-attachments.ts`
- Test: `src/components/conversation/prompt-attachments.test.ts`
- Modify: `src/renderer/use-conversation.ts` (`send`)
- Modify: `src/components/conversation-panel.tsx`
- Test: `src/components/conversation-panel.test.tsx`

**Interfaces:**
- Consumes: `PromptAttachment`, `CONVERSATION_IMAGE_TYPES`, `MAX_ATTACHMENT_IMAGE_BYTES`, `MAX_PROMPT_ATTACHMENTS` (Task 1); `window.fractal.attachments.pathFor` (Task 7).
- Produces: `PromptInput` props `resolvePath?: (file: File) => string` and `validateFile?: (file: File, path: string) => string | null`; `PromptInputFile = FileUIPart & { id: string; path?: string }`; `PromptInputMessage.files: (FileUIPart & { path?: string })[]`; `promptAttachments(files): PromptAttachment[]`; `composerFileError(file, path): string | null`; `useConversation().send(text: string, attachments?: PromptAttachment[])`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/conversation/prompt-attachments.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { composerFileError, promptAttachments } from '@/components/conversation/prompt-attachments';

const file = (name: string, type: string, size = 10) => ({ name, type, size }) as File;

describe('promptAttachments', () => {
  test('sends disk files by path and pasted images as base64 bytes', () => {
    expect(promptAttachments([
      { type: 'file', url: 'blob:1', mediaType: 'text/markdown', filename: 'notes.md', path: '/repo/notes.md' },
      { type: 'file', url: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png', filename: 'shot.png' },
    ])).toEqual([
      { kind: 'path', path: '/repo/notes.md' },
      { kind: 'bytes', name: 'shot.png', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
    ]);
  });

  test('refuses a pasted image that never became a data URL', () => {
    expect(() => promptAttachments([{ type: 'file', url: 'blob:1', mediaType: 'image/png', filename: 'shot.png' }])).toThrow('Could not read shot.png');
  });
});

describe('composerFileError', () => {
  test('accepts files on disk and pasted supported images', () => {
    expect(composerFileError(file('notes.md', 'text/markdown'), '/repo/notes.md')).toBeNull();
    expect(composerFileError(file('shot.png', 'image/png'), '')).toBeNull();
  });

  test('rejects pathless non-images and oversized images', () => {
    expect(composerFileError(file('clip.bmp', 'image/bmp'), '')).toBe("clip.bmp can't be attached: it has no file on disk and isn't a PNG, JPEG, GIF, or WebP image.");
    expect(composerFileError(file('huge.png', 'image/png', 20 * 1024 * 1024 + 1), '/repo/huge.png')).toBe('huge.png is larger than 20 MiB.');
  });
});
```

Append to `src/components/conversation-panel.test.tsx`:

```ts
test('attaches a picked file, sends it by path with no text, and clears it after sending', async () => {
  const send = vi.fn<ConversationApi['continue']>(async () => undefined);
  install('idle', send);
  Object.assign(window.fractal, { attachments: { pathFor: () => '/work/fractal/notes.md' } });
  URL.createObjectURL = vi.fn(() => 'blob:notes');
  URL.revokeObjectURL = vi.fn();
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  await userEvent.upload(screen.getByLabelText('Upload files'), new File(['# Notes'], 'notes.md', { type: 'text/markdown' }));
  expect(screen.getByText('notes.md')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(ref, { text: '', attachments: [{ kind: 'path', path: '/work/fractal/notes.md' }] }));
  await waitFor(() => expect(screen.queryByText('notes.md')).toBeNull());
});

test('keeps attachments when the send fails', async () => {
  install('idle', async () => { throw new Error('Error invoking remote method: /work/fractal/notes.md no longer exists or cannot be read'); });
  Object.assign(window.fractal, { attachments: { pathFor: () => '/work/fractal/notes.md' } });
  URL.createObjectURL = vi.fn(() => 'blob:notes');
  URL.revokeObjectURL = vi.fn();
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  await userEvent.upload(screen.getByLabelText('Upload files'), new File(['# Notes'], 'notes.md', { type: 'text/markdown' }));
  await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('no longer exists'));
  expect(screen.getByText('notes.md')).toBeTruthy();
});
```

`PromptInputSubmit` is labelled `Submit`, and the existing panel tests click it by that name. `install` defines `window.fractal` with `configurable: true`; `Object.assign` onto it adds `attachments`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/components/conversation/prompt-attachments.test.ts src/components/conversation-panel.test.tsx`
Expected: FAIL. The helper module is missing, and the composer has no chips and doesn't send attachments.

- [ ] **Step 3: Record disk paths in `PromptInput`**

In `src/components/ai-elements/prompt-input.tsx`:

1. After the imports, add `export type PromptInputFile = FileUIPart & { id: string; path?: string };` and replace every occurrence of the type expression `FileUIPart & { id: string }` in the file with `PromptInputFile` (for example `sed -i 's/FileUIPart & { id: string }/PromptInputFile/g'`, then fix the one declaration line so it still reads `FileUIPart & { id: string; path?: string }`).
2. Change `PromptInputMessage.files` to `files: (FileUIPart & { path?: string })[];`.
3. Add to `PromptInputProps`:

```ts
  /** Disk path for a file, or '' when it has none; recorded on the attachment as it is added. */
  resolvePath?: (file: File) => string;
  /** An error message to reject a file as it is added, given its disk path ('' when it has none). */
  validateFile?: (file: File, path: string) => string | null;
```

and destructure `resolvePath, validateFile` in `PromptInput`.
4. In `addLocal`, after `sized` is computed and before `setItems`, add:

```ts
      const checked: { file: File; path: string }[] = [];
      for (const file of sized) {
        const path = resolvePath?.(file) ?? '';
        const rejection = validateFile?.(file, path);
        if (rejection) { onError?.({ code: 'accept', message: rejection }); continue; }
        checked.push({ file, path });
      }
```

then inside `setItems`, slice `checked` instead of `sized` for `capped`, compare `checked.length > capacity` for the `max_files` error, and build each item as:

```ts
        for (const { file, path } of capped) {
          next.push({
            id: nanoid(),
            type: "file",
            url: URL.createObjectURL(file),
            mediaType: file.type,
            filename: file.name,
            ...(path ? { path } : {}),
          });
        }
```

Add `resolvePath, validateFile` to `addLocal`'s dependency array.
5. In `handleSubmit`, change the conversion condition to `if (!item.path && item.url && item.url.startsWith("blob:"))`, so files on disk are never read into memory, and type the `.then` parameter as `(convertedFiles: (FileUIPart & { path?: string })[])`.

`ai-elements` is excluded from vitest; the panel tests cover this behaviour.

- [ ] **Step 4: Add the composer helpers**

Create `src/components/conversation/prompt-attachments.ts`:

```ts
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input';
import { CONVERSATION_IMAGE_TYPES, MAX_ATTACHMENT_IMAGE_BYTES, type ConversationImageType, type PromptAttachment } from '@/shared/conversation-contract';

const isImageType = (type: string): type is ConversationImageType => (CONVERSATION_IMAGE_TYPES as readonly string[]).includes(type);

/** Why a file cannot be attached, or null when it can. */
export function composerFileError(file: File, path: string): string | null {
  const image = isImageType(file.type);
  if (!path && !image) return `${file.name} can't be attached: it has no file on disk and isn't a PNG, JPEG, GIF, or WebP image.`;
  if (image && file.size > MAX_ATTACHMENT_IMAGE_BYTES) return `${file.name} is larger than 20 MiB.`;
  return null;
}

/** Files on disk go by path; pasted images go as the base64 payload of their data URL. */
export function promptAttachments(files: PromptInputMessage['files']): PromptAttachment[] {
  return files.map((file): PromptAttachment => {
    if (file.path) return { kind: 'path', path: file.path };
    const name = file.filename ?? 'image';
    const comma = file.url.indexOf(',');
    if (!file.url.startsWith('data:') || comma === -1 || !isImageType(file.mediaType)) throw new Error(`Could not read ${name}`);
    return { kind: 'bytes', name, mediaType: file.mediaType, data: file.url.slice(comma + 1) };
  });
}
```

- [ ] **Step 5: Send attachments from the hook**

In `src/renderer/use-conversation.ts`, import `type PromptAttachment` from the contract and change `send` to:

```ts
  const send = useCallback((text: string, attachments: PromptAttachment[] = []): Promise<void | undefined> | undefined => {
    const active = currentActiveLoad(state.ref, state.loadId);
    if (!canSend || !active || !state.ref) return undefined;
    try {
      const prompt = parsePromptInput(attachments.length > 0 ? { text, attachments } : { text });
      return containActionSettlement(window.fractal.conversations.continue(state.ref, prompt), active);
    } catch {
      // The bridge never sees malformed renderer input.
      return undefined;
    }
  }, [canSend, containActionSettlement, currentActiveLoad, state.loadId, state.ref]);
```

The existing `send('Continue this')` tests keep passing unchanged.

- [ ] **Step 6: Build the composer UI**

In `src/components/conversation-panel.tsx`:

1. Add `Paperclip` to the `lucide-react` import. Add `PromptInputAttachment, PromptInputAttachments, PromptInputButton, PromptInputHeader, usePromptInputAttachments` to the `prompt-input` import. Import `composerFileError, promptAttachments` from `@/components/conversation/prompt-attachments`, and `MAX_PROMPT_ATTACHMENTS` and `type PromptAttachment` from the contract.
2. Add two small components above `NativeConversationPanel`:

```tsx
function AttachButton({ disabled }: { disabled: boolean }) {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton aria-label="Attach files" disabled={disabled} onClick={attachments.openFileDialog}>
      <Paperclip aria-hidden className="size-4" />
    </PromptInputButton>
  );
}

function ComposerSubmit({ blocked, hasText, sending }: { blocked: boolean; hasText: boolean; sending: boolean }) {
  const attachments = usePromptInputAttachments();
  return <PromptInputSubmit disabled={blocked || sending || (!hasText && attachments.files.length === 0)} status={sending ? 'submitted' : 'ready'} />;
}
```

3. Replace `handleSubmit` with a version where every "not sent" outcome rejects, so `PromptInput` keeps the attachments. It clears them only when the promise resolves.

```tsx
  const handleSubmit = async (message: PromptInputMessage) => {
    if (!eligible || pendingSend.current || (!message.text.trim() && message.files.length === 0)) throw new Error('Message was not sent');
    let attachments: PromptAttachment[];
    try { attachments = promptAttachments(message.files); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    const draft = message.text;
    const dispatched = send(draft.trim(), attachments);
    if (!dispatched) throw new Error('Message was not sent');
    const attempt = {};
    pendingSend.current = attempt;
    setSending(true);
    setActionError(null);
    try {
      await dispatched;
      if (pendingSend.current === attempt) setInput((current) => current === draft ? '' : current);
    } catch (cause) {
      if (pendingSend.current === attempt) setActionError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      if (pendingSend.current === attempt) {
        pendingSend.current = null;
        setSending(false);
      }
    }
  };
```

4. Replace the `<PromptInput …>` block with:

```tsx
        <PromptInput
          maxFiles={MAX_PROMPT_ATTACHMENTS}
          multiple
          onError={(error) => setActionError(error.message)}
          onSubmit={handleSubmit}
          resolvePath={(file) => window.fractal.attachments.pathFor(file)}
          validateFile={composerFileError}
        >
          <PromptInputHeader className="p-0">
            <PromptInputAttachments className="px-3 pt-3 pb-0">{(file) => <PromptInputAttachment data={file} />}</PromptInputAttachments>
          </PromptInputHeader>
          <PromptInputBody><PromptInputTextarea aria-label="Message" disabled={!eligible || sending} onChange={(event) => setInput(event.target.value)} placeholder="Ask anything" value={input} /></PromptInputBody>
          <PromptInputFooter className="justify-between">
            <AttachButton disabled={!eligible || sending} />
            <div className="flex items-center gap-1">
              {state.runtime === 'active-in-fractal' && state.capabilities?.interrupt && (
                <Button aria-label="Interrupt session" disabled={stopping} onClick={() => { void stop(); }} size="icon-sm" type="button" variant="ghost"><Square aria-hidden className="size-3" /></Button>
              )}
              <ComposerSubmit blocked={!eligible} hasText={Boolean(input.trim())} sending={sending} />
            </div>
          </PromptInputFooter>
        </PromptInput>
```

If `PromptInputHeader` adds padding that looks wrong with no attachments, remember that `PromptInputAttachments` renders `null` when empty. Adjust the header only if an empty header leaves a visible gap.

Drag-and-drop onto the composer and paste both route through `PromptInput`'s existing `add`, so they pick up `resolvePath` and `validateFile` with no extra wiring.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/components src/renderer && pnpm exec tsc --noEmit && pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components src/renderer
git commit -m "feat(composer): attach files by picker, drop, or paste"
```

---

### Task 9: Transcript thumbnails, chips, and preview dialog

**Files:**
- Create: `src/components/conversation/attachment-preview-context.tsx`
- Create: `src/components/conversation/message-attachments.tsx`
- Test: `src/components/conversation/message-attachments.test.tsx`
- Modify: `src/components/conversation/highlighted-command.tsx`
- Modify: `src/components/conversation/conversation-turn.tsx`
- Modify: `src/components/conversation-panel.tsx`

**Interfaces:**
- Consumes: `AttachmentPreview`, `UserMessageAttachment`, `AttachmentOpenAction` (Task 1); `ConversationApi.previewAttachment/openAttachment` (Tasks 1, 7); `ConversationImages` (existing).
- Produces:
  - `AttachmentPreviewProvider({ conversationRef, children })`
  - `useAttachmentPreviews(): { load(path: string, fresh?: boolean): Promise<AttachmentPreview>; open(path: string, action: AttachmentOpenAction): Promise<void> }`
  - `MessageAttachments({ attachments, sentAt }: { attachments: UserMessageAttachment[]; sentAt?: number })`
  - `HighlightedCommand` gains an optional `language` prop, defaulting to `'bash'`.

- [ ] **Step 1: Write the failing test**

Create `src/components/conversation/message-attachments.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { AttachmentPreviewProvider } from './attachment-preview-context';
import { MessageAttachments } from './message-attachments';
import type { AttachmentPreview, ConversationApi, ConversationRef } from '@/shared/conversation-contract';

const ref: ConversationRef = { provider: 'codex', nativeSessionId: 'attach-test', projectPath: '/work/fractal' };
function install(previews: Record<string, AttachmentPreview>) {
  const previewAttachment = vi.fn<ConversationApi['previewAttachment']>(async (_ref, path) => previews[path] ?? { kind: 'missing' });
  const openAttachment = vi.fn<ConversationApi['openAttachment']>(async () => undefined);
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: { previewAttachment, openAttachment } } });
  return { previewAttachment, openAttachment };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// NOTES has no extension, so it renders as plain text and the assertion is not split across highlight tokens.
test('renders a file chip that opens a text preview with open and reveal actions', async () => {
  const api = install({ '/work/fractal/NOTES': { kind: 'text', text: 'Remember the parser', truncated: false, size: 19, modifiedAt: 1 } });
  render(<AttachmentPreviewProvider conversationRef={ref}><MessageAttachments attachments={[{ path: '/work/fractal/NOTES', kind: 'file' }]} sentAt={5} /></AttachmentPreviewProvider>);
  await userEvent.click(await screen.findByRole('button', { name: 'Preview NOTES' }));
  expect(await screen.findByText('Remember the parser')).toBeTruthy();
  expect(screen.queryByText('Modified since this message was sent')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
  expect(api.openAttachment).toHaveBeenCalledWith(ref, '/work/fractal/NOTES', 'reveal');
  await userEvent.click(screen.getByRole('button', { name: 'Open with default app' }));
  expect(api.openAttachment).toHaveBeenCalledWith(ref, '/work/fractal/NOTES', 'open');
});

test('flags a file modified after the message and a truncated preview', async () => {
  install({ '/work/fractal/big.log': { kind: 'text', text: 'start', truncated: true, size: 999_999, modifiedAt: 10 } });
  render(<AttachmentPreviewProvider conversationRef={ref}><MessageAttachments attachments={[{ path: '/work/fractal/big.log', kind: 'file' }]} sentAt={5} /></AttachmentPreviewProvider>);
  await userEvent.click(await screen.findByRole('button', { name: 'Preview big.log' }));
  expect(await screen.findByText('Modified since this message was sent')).toBeTruthy();
  expect(screen.getByText(/Showing the first 256 KiB/)).toBeTruthy();
});

test('marks a missing file and loads an image attachment as a thumbnail', async () => {
  install({ '/tmp/shot.png': { kind: 'image', image: { mediaType: 'image/png', data: 'AAA' }, size: 3, modifiedAt: 1 } });
  render(<AttachmentPreviewProvider conversationRef={ref}><MessageAttachments attachments={[{ path: '/work/fractal/gone.ts', kind: 'file' }, { path: '/tmp/shot.png', kind: 'image' }]} /></AttachmentPreviewProvider>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview gone.ts' }).textContent).toContain('missing'));
  expect(await screen.findByRole('button', { name: 'View image 1 of 1' })).toBeTruthy();
});

test('falls back to a chip when an image attachment cannot be shown', async () => {
  install({});
  render(<AttachmentPreviewProvider conversationRef={ref}><MessageAttachments attachments={[{ path: '/tmp/gone.png', kind: 'image' }]} /></AttachmentPreviewProvider>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview gone.png' }).textContent).toContain('missing'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/components/conversation/message-attachments.test.tsx`
Expected: FAIL. The modules are missing.

- [ ] **Step 3: Let the highlighter take a language**

In `src/components/conversation/highlighted-command.tsx`, change the import to `import { code, type HighlightOptions, type HighlightResult } from '@streamdown/code';` and the component to:

```tsx
/** Code syntax-highlighted once the highlighter loads; plain text until then. Defaults to a shell command. */
export function HighlightedCommand({ command, language = 'bash', className }: { command: string; language?: HighlightOptions['language']; className?: string }) {
```

with `language` replacing the literal `'bash'` in `code.highlight` and added to the effect's dependency array (`[command, language]`).

- [ ] **Step 4: Implement the preview context**

Create `src/components/conversation/attachment-preview-context.tsx`:

```tsx
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AttachmentOpenAction, AttachmentPreview, ConversationRef } from '@/shared/conversation-contract';

type AttachmentPreviews = {
  /** The cached preview, or a fresh read when fresh is set (the dialog shows the file as it is now). */
  load(path: string, fresh?: boolean): Promise<AttachmentPreview>;
  open(path: string, action: AttachmentOpenAction): Promise<void>;
};

const AttachmentPreviewContext = createContext<AttachmentPreviews | null>(null);

export function AttachmentPreviewProvider({ conversationRef, children }: { conversationRef: ConversationRef; children: ReactNode }) {
  const value = useMemo<AttachmentPreviews>(() => {
    // Virtual rows remount as they scroll; the cache keeps that from re-reading files.
    const cache = new Map<string, Promise<AttachmentPreview>>();
    return {
      load(path, fresh = false) {
        const cached = cache.get(path);
        if (cached && !fresh) return cached;
        const request = window.fractal.conversations.previewAttachment(conversationRef, path);
        cache.set(path, request);
        request.catch(() => { if (cache.get(path) === request) cache.delete(path); });
        return request;
      },
      open: (path, action) => window.fractal.conversations.openAttachment(conversationRef, path, action),
    };
  }, [conversationRef]);
  return <AttachmentPreviewContext.Provider value={value}>{children}</AttachmentPreviewContext.Provider>;
}

export function useAttachmentPreviews(): AttachmentPreviews {
  const context = useContext(AttachmentPreviewContext);
  if (!context) throw new Error('useAttachmentPreviews must be used within AttachmentPreviewProvider');
  return context;
}
```

- [ ] **Step 5: Implement the transcript attachments**

Create `src/components/conversation/message-attachments.tsx`:

```tsx
import { code } from '@streamdown/code';
import { FileIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { AttachmentPreview, UserMessageAttachment } from '@/shared/conversation-contract';
import { useAttachmentPreviews } from './attachment-preview-context';
import { ConversationImages } from './conversation-images';
import { HighlightedCommand } from './highlighted-command';

type Loaded = { status: 'loading' } | { status: 'ready'; preview: AttachmentPreview } | { status: 'failed' };

const basename = (path: string): string => path.split(/[\\/]/).pop() || path;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function languageFor(path: string) {
  const extension = basename(path).split('.').pop()?.toLowerCase() ?? '';
  return extension && code.supportsLanguage(extension as never) ? extension as Parameters<typeof code.supportsLanguage>[0] : undefined;
}

function usePreview(path: string, fresh = false): Loaded {
  const previews = useAttachmentPreviews();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  useEffect(() => {
    let current = true;
    setLoaded({ status: 'loading' });
    previews.load(path, fresh).then(
      (preview) => { if (current) setLoaded({ status: 'ready', preview }); },
      () => { if (current) setLoaded({ status: 'failed' }); },
    );
    return () => { current = false; };
  }, [path, fresh, previews]);
  return loaded;
}

/** Attachments on a sent user message: images as thumbnails, everything else as chips that open a preview. */
export function MessageAttachments({ attachments, sentAt }: { attachments: UserMessageAttachment[]; sentAt?: number }) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {attachments.map((attachment) => attachment.kind === 'image'
        ? <AttachmentThumbnail key={attachment.path} path={attachment.path} sentAt={sentAt} />
        : <AttachmentChip key={attachment.path} path={attachment.path} sentAt={sentAt} />)}
    </div>
  );
}

function AttachmentThumbnail({ path, sentAt }: { path: string; sentAt?: number }) {
  const loaded = usePreview(path);
  if (loaded.status === 'loading') return <div aria-hidden className="h-28 w-28 animate-pulse rounded-lg border bg-muted/30" />;
  if (loaded.status === 'ready' && loaded.preview.kind === 'image') return <ConversationImages images={[loaded.preview.image]} />;
  return <AttachmentChip path={path} sentAt={sentAt} />;
}

function AttachmentChip({ path, sentAt }: { path: string; sentAt?: number }) {
  const loaded = usePreview(path);
  const missing = loaded.status === 'ready' && loaded.preview.kind === 'missing';
  const name = basename(path);
  return (
    <Dialog>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger
              aria-label={`Preview ${name}`}
              className={cn('flex h-8 max-w-60 items-center gap-1.5 rounded-md border px-2 text-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', missing && 'opacity-60')}
            >
              <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{name}</span>
              {missing && <span className="shrink-0 text-xs text-muted-foreground">missing</span>}
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent>{path}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogContent className="flex max-h-[88vh] w-[min(56rem,94vw)] max-w-none flex-col gap-3 sm:max-w-none">
        <AttachmentDialogBody path={path} sentAt={sentAt} />
      </DialogContent>
    </Dialog>
  );
}

function AttachmentDialogBody({ path, sentAt }: { path: string; sentAt?: number }) {
  // Opening the dialog re-reads the file so it shows what is on disk now.
  const loaded = usePreview(path, true);
  const previews = useAttachmentPreviews();
  const preview = loaded.status === 'ready' ? loaded.preview : undefined;
  const exists = preview !== undefined && preview.kind !== 'missing';
  const modified = exists && sentAt !== undefined && preview.modifiedAt > sentAt;
  return (
    <>
      <div className="min-w-0 space-y-1">
        <DialogTitle className="truncate text-sm font-medium">{basename(path)}</DialogTitle>
        <DialogDescription className="truncate font-mono text-xs">{path}{exists ? ` · ${formatSize(preview.size)}` : ''}</DialogDescription>
      </div>
      {modified && <p className="text-xs text-amber-600 dark:text-amber-400" role="status">Modified since this message was sent</p>}
      <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/20">
        {loaded.status === 'loading' && <p className="p-4 text-sm text-muted-foreground">Reading file…</p>}
        {loaded.status === 'failed' && <p className="p-4 text-sm text-destructive">This file could not be read.</p>}
        {preview?.kind === 'missing' && <p className="p-4 text-sm text-muted-foreground">This file no longer exists at this path.</p>}
        {preview?.kind === 'binary' && <p className="p-4 text-sm text-muted-foreground">No preview for this file type.</p>}
        {preview?.kind === 'image' && <img alt="" className="mx-auto max-h-[70vh] object-contain" src={`data:${preview.image.mediaType};base64,${preview.image.data}`} />}
        {preview?.kind === 'text' && (languageFor(path)
          ? <HighlightedCommand className="p-4 text-xs leading-5" command={preview.text} language={languageFor(path)} />
          : <pre className="p-4 font-mono text-xs leading-5 whitespace-pre-wrap">{preview.text}</pre>)}
      </div>
      {preview?.kind === 'text' && preview.truncated && <p className="text-xs text-muted-foreground">Showing the first 256 KiB of {formatSize(preview.size)}.</p>}
      <div className="flex justify-end gap-2">
        <Button disabled={!exists} onClick={() => { void previews.open(path, 'reveal'); }} size="sm" type="button" variant="outline">Show in folder</Button>
        <Button disabled={!exists} onClick={() => { void previews.open(path, 'open'); }} size="sm" type="button">Open with default app</Button>
      </div>
    </>
  );
}
```

If `code.supportsLanguage` doesn't accept a plain string at the type level, keep the `as never` cast in `languageFor`; the runtime check is what matters. If the dialog's buttons are hard to target because `DialogContent` renders a close button also named "Close", the test targets only "Show in folder" and "Open with default app", which are unique.

- [ ] **Step 6: Render attachments in the turn and provide the context**

In `src/components/conversation/conversation-turn.tsx`, import `MessageAttachments` from `./message-attachments`, and add after the `images` line inside `<Message from="user">`:

```tsx
        {turn.userMessage.attachments && <MessageAttachments attachments={turn.userMessage.attachments} sentAt={turn.userMessage.createdAt} />}
```

In `src/components/conversation-panel.tsx`, import `AttachmentPreviewProvider` from `@/components/conversation/attachment-preview-context`, and wrap the `VirtualTimeline` element:

```tsx
<AttachmentPreviewProvider conversationRef={conversationRef}><VirtualTimeline … /></AttachmentPreviewProvider>
```

keeping every existing `VirtualTimeline` prop unchanged.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/components && pnpm exec tsc --noEmit && pnpm lint`
Expected: PASS. If an existing `conversation-turn.test.tsx` renders a turn with attachments outside the provider, none do today, so no change is needed there.

- [ ] **Step 8: Commit**

```bash
git add src/components
git commit -m "feat(conversation): show message attachments with a scoped preview dialog"
```

---

### Task 10: Verify in the running app

**Files:** none (verification only; fix anything found in the task that owns it, with its own test).

- [ ] **Step 1: Full checks**

Run: `pnpm lint && pnpm exec tsc --noEmit && pnpm test`
Expected: all pass. Record the test count.

- [ ] **Step 2: Drive the real app, Claude**

Start the app with `pnpm start` (use the `run` skill to launch and drive it). In a scratch project folder with a small `notes.md`, open or create a Claude conversation and:

1. Click the paperclip, pick `notes.md`, paste a screenshot, and type "What does the note say, and what is in the image?". Send.
2. Confirm the agent's work shows a Read of `notes.md` and the answer describes the image.
3. Confirm the sent message shows a `notes.md` chip and an image thumbnail, and no `<attachments>` text.
4. Click the chip: the text preview shows; "Show in folder" and "Open with default app" work.
5. Reopen the conversation from the sidebar: the chip and thumbnail are still there.
6. Edit `notes.md`, reopen the chip: "Modified since this message was sent" appears.
7. Attach a file, delete it on disk, send: the error line names the file, and the draft and chip stay.

- [ ] **Step 3: Drive the real app, Codex**

Repeat steps 1–5 in a Codex conversation. In step 5, the pasted screenshot comes back as a `localImage` path under `<userData>/attachments/…` and must render as a thumbnail through the preview call.

- [ ] **Step 4: Report**

Report what was observed for each numbered check, including any that failed and what was fixed. Remove any scratch Claude sessions or projects created during verification only with the user's say-so.

---

## Notes for the executor

- **Known side effect, not in scope:** Claude conversation titles derived from the first user message may now include the `<attachments>` block when the first message has one. Report it if you see it; don't fix it in this plan.
- **Stale doc, not in scope:** `CLAUDE.md` says "There is no test suite yet"; vitest exists. Leave it.
- The spec's Verification section lists the behaviours each task's tests cover; if a task's tests pass but a spec behaviour in that task's area has no test, add one in that task.
