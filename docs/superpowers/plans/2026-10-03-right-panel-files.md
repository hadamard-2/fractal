# Right Panel Files Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the right panel's Files entry a working, read-only repo browser: file tabs with VS Code-style preview rules, a lazily loaded tree with a name filter, a live-updating highlighted viewer, and an Open menu that hands the file to the user's editor.

**Architecture:** Main owns every filesystem and process operation behind a new `files` preload API that follows the terminal contract's shape (one validated invoke channel, one event channel, owner-scoped resources). Requests are confined to project roots main already knows from the conversation service, and every path is checked with `realpath` against that root. The renderer generalises the panel's tab list to terminal and file tabs, and fetches on demand: folders when expanded, files when opened, the filter list when the filter opens. Main pushes "changed" events for exactly what is on screen.

**Tech Stack:** Electron 43 (main, preload, contextBridge), Node `fs`/`child_process`, git CLI, React 19, `@tanstack/react-virtual` 3.14, `@streamdown/code` (Shiki), shadcn/ui (Radix), Vitest 4 with jsdom and Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-03-right-panel-files-design.md`

## Global Constraints

- Keep `contextIsolation` on and `nodeIntegration` off. The renderer reaches files only through `window.fractal.files`.
- Main never runs a string from the renderer as a command. Editors start from a fixed argument list with `shell: false`, `detached: true`, `stdio: 'ignore'`.
- No editor detection on Windows (`process.platform === 'win32'`): the Open menu offers only "System default" and "Show in folder" there.
- A request's `root` must be a project main knows through the conversation service, and every resolved path must stay inside `realpath(root)`.
- Starting values, all Fractal's own: `FILE_VIEW_MAX_BYTES` = 2 MiB, `FILE_HIGHLIGHT_MAX_BYTES` = 256 KiB, `FILE_LIST_MAX_ENTRIES` = 50,000, watch debounce = 100 ms, tree docks beside the viewer from a 560px panel width, docked tree width = 240px.
- Sizes are shown in B/KiB/MiB through the shared `formatSize`.
- No new dependencies. Do not touch the build config or the version pins in `docs/environment-notes.md`.
- Comments and messages state Fractal's own reasons, never a claim about another system's internals.
- Commits follow Conventional Commits (`<type>(scope): <subject>`), with a bulleted body when a commit covers more than one change. No attribution lines. Never `git push`.
- Markdown files: never hard-wrap paragraphs.
- Before a task is done: `pnpm test`, `pnpm lint`, and `pnpm exec tsc --noEmit` all pass.

---

## File Structure

**Main process** (`src/main/`)
- `text-file.ts` (new): `decodeText`, the text/binary rule shared by attachment previews and Files.
- `ipc-owners.ts` (new): owner tracking and sender authorisation, extracted from `terminal-ipc.ts` and reused by Files.
- `files/project-paths.ts` (new): confinement of project-relative paths (`resolveInProject`, `resolveParentInProject`, `isInside`, `isMissing`, `OutsideProjectError`).
- `files/git.ts` (new): `ignoredNames` (`git check-ignore`) and `listGitFiles` (`git ls-files`).
- `files/file-service.ts` (new): `listDirectory`, `readProjectFile`, `listProjectFiles`.
- `files/file-watch-service.ts` (new): owner-scoped, debounced folder and file watches.
- `files/editors.ts` (new): editor table, detection, launch, and `openWith`.
- `files/files-ipc.ts` (new): the `files` IPC handler.
- `attachments/preview.ts`: imports `decodeText` instead of defining it.
- `terminal-ipc.ts`: uses `createOwnerTracker`.
- `conversation-registry.ts`, `conversation-service.ts`: `hasProject`, `knowsProject`.
- `settings-store.ts`, `settings-ipc.ts`: the `fileOpener` setting.
- `../main.ts`, `../preload.ts`, `../global.d.ts`: wiring.

**Shared** (`src/shared/`)
- `files-contract.ts` (new): channels, limits, types, request and event parsers.
- `settings-contract.ts`: `fileOpener`.

**Renderer**
- `src/renderer/file-display.ts` (new): `basename`, `formatSize`, `languageFor`, `absoluteProjectPath`, moved out of `message-attachments.tsx`.
- `src/renderer/panel-tabs.ts` (new): the pure tab model (terminal and file tabs, preview rules, recency).
- `src/renderer/file-filter.ts` (new): `filterPaths`.
- `src/renderer/use-watched-load.ts` (new): load and reload on change events.
- `src/renderer/right-panel-layout.ts`: `filesTreeDocked`, `FILES_TREE_DOCK_MIN_WIDTH`, `FILES_TREE_WIDTH`.
- `src/components/code/highlighted-tokens.tsx` (new): `useHighlightedTokens`, `TokenLine`, extracted from `highlighted-command.tsx`.
- `src/components/right-panel/panel-tabs.tsx` (new): the tab row for both tab kinds; replaces `TerminalTabs`.
- `src/components/right-panel/files/file-tree.tsx` (new), `file-viewer.tsx` (new), `open-menu.tsx` (new), `files-pane.tsx` (new).
- `src/components/right-panel/tool-entries.tsx`, `terminal-tabs.tsx`, `src/components/right-workspace.tsx`: wiring.

---

### Task 1: Extract shared file display and decoding helpers

Pure refactor with no behaviour change. It moves code that Files will reuse out of the attachments feature.

**Files:**
- Create: `src/main/text-file.ts`, `src/main/text-file.test.ts`
- Modify: `src/main/attachments/preview.ts`
- Create: `src/renderer/file-display.ts`, `src/renderer/file-display.test.ts`
- Modify: `src/components/conversation/message-attachments.tsx`
- Create: `src/components/code/highlighted-tokens.tsx`
- Modify: `src/components/conversation/highlighted-command.tsx`

**Interfaces:**
- Produces: `decodeText(bytes: Uint8Array, truncated?: boolean): string | undefined`
- Produces: `basename(path: string): string`, `formatSize(bytes: number): string`, `languageFor(path: string): HighlightLanguage | undefined`, `absoluteProjectPath(root: string, path: string): string`, `type HighlightLanguage`
- Produces: `useHighlightedTokens(source: string, language: HighlightLanguage | undefined): HighlightResult['tokens'] | null`, `TokenLine({ tokens })`

- [ ] **Step 1: Write the failing tests**

`src/main/text-file.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { decodeText } from './text-file';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('decodeText', () => {
  test('decodes UTF-8 text', () => {
    expect(decodeText(new TextEncoder().encode('héllo'))).toBe('héllo');
  });

  test('treats a NUL byte or invalid UTF-8 as binary', () => {
    expect(decodeText(bytes(0x61, 0x00, 0x62))).toBeUndefined();
    expect(decodeText(bytes(0xe9, 0x61))).toBeUndefined();
  });

  test('holds back a character cut off at the end only when the bytes were truncated', () => {
    const cut = new TextEncoder().encode('aé').subarray(0, 2);
    expect(decodeText(cut, true)).toBe('a');
    expect(decodeText(cut)).toBeUndefined();
  });
});
```

`src/renderer/file-display.test.ts`:

```ts
import { expect, test } from 'vitest';
import { absoluteProjectPath, basename, formatSize, languageFor } from './file-display';

test('names a file by its last path segment', () => {
  expect(basename('src/components/a.tsx')).toBe('a.tsx');
  expect(basename('C:\\repo\\a.ts')).toBe('a.ts');
});

test('formats sizes in B, KiB and MiB', () => {
  expect(formatSize(512)).toBe('512 B');
  expect(formatSize(1536)).toBe('1.5 KiB');
  expect(formatSize(14 * 1024 * 1024)).toBe('14.0 MiB');
});

test('picks a language from the extension, or from the name of a file without one', () => {
  expect(languageFor('src/a.ts')).toBe('ts');
  expect(languageFor('vite.renderer.config.mts')).toBe('mts');
  expect(languageFor('Dockerfile')).toBe('dockerfile');
  expect(languageFor('notes.unknownext')).toBeUndefined();
});

test('joins a project-relative path onto its root with the root\'s separator', () => {
  expect(absoluteProjectPath('/repo', 'src/a.ts')).toBe('/repo/src/a.ts');
  expect(absoluteProjectPath('/repo/', 'a.ts')).toBe('/repo/a.ts');
  expect(absoluteProjectPath('C:\\repo', 'src/a.ts')).toBe('C:\\repo\\src\\a.ts');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/text-file.test.ts src/renderer/file-display.test.ts`
Expected: FAIL, because the modules `./text-file` and `./file-display` cannot be found.

- [ ] **Step 3: Implement the helpers and move the callers onto them**

`src/main/text-file.ts`:

```ts
/**
 * A file's bytes as UTF-8 text, or undefined when they are binary: any NUL
 * byte, or bytes that are not valid UTF-8. With `truncated`, a multibyte
 * character cut off at the end is held back instead of failing the decode.
 */
export function decodeText(bytes: Uint8Array, truncated = false): string | undefined {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated }); } catch { return undefined; }
}
```

In `src/main/attachments/preview.ts`, delete the local `decodeText` function (the last function in the file) and add the import:

```ts
import { decodeText } from '@/main/text-file';
```

The existing call `decodeText(sample, truncated)` stays as it is.

`src/renderer/file-display.ts` (the first three helpers are moved verbatim from `message-attachments.tsx`):

```ts
import { code } from '@streamdown/code';

export type HighlightLanguage = Parameters<typeof code.supportsLanguage>[0];

export const basename = (path: string): string => path.split(/[\\/]/).pop() || path;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The highlighter language for a file: its extension, or for a file with none its name; undefined when unsupported. */
export function languageFor(path: string): HighlightLanguage | undefined {
  const extension = basename(path).split('.').pop()?.toLowerCase() ?? '';
  return extension && code.supportsLanguage(extension as HighlightLanguage) ? extension as HighlightLanguage : undefined;
}

/** A project-relative, '/'-separated path joined onto its project root, using the root's own separator. */
export function absoluteProjectPath(root: string, path: string): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${path.split('/').join(separator)}`;
}
```

In `src/components/conversation/message-attachments.tsx`, delete the local `basename`, `formatSize`, and `languageFor` definitions and the `import { code } from '@streamdown/code';` line, then add:

```ts
import { basename, formatSize, languageFor } from '@/renderer/file-display';
```

`src/components/code/highlighted-tokens.tsx`:

```tsx
import { code, type HighlightResult } from '@streamdown/code';
import { useEffect, useState, type CSSProperties } from 'react';
import type { HighlightLanguage } from '@/renderer/file-display';

// The same highlighter and themes Streamdown uses for code blocks in messages.
const themes = code.getThemes();

type Token = HighlightResult['tokens'][number][number];

/** `source` as highlighted lines of tokens; null until the highlighter has loaded, or with no language. */
export function useHighlightedTokens(source: string, language: HighlightLanguage | undefined): HighlightResult['tokens'] | null {
  const [result, setResult] = useState<HighlightResult | null>(null);
  useEffect(() => {
    if (!language) { setResult(null); return; }
    let current = true;
    const ready = code.highlight({ code: source, language, themes }, (highlighted) => {
      if (current) setResult(highlighted);
    });
    setResult(ready);
    return () => { current = false; };
  }, [source, language]);
  return result?.tokens ?? null;
}

/** One highlighted line, coloured for the light and dark themes. */
export function TokenLine({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, index) => (
        <span
          className="text-[var(--hl-light)] dark:text-[var(--hl-dark)]"
          key={index}
          style={{ '--hl-light': token.htmlStyle?.color ?? token.color, '--hl-dark': token.htmlStyle?.['--shiki-dark'] ?? token.color } as CSSProperties}
        >
          {token.content}
        </span>
      ))}
    </>
  );
}
```

Replace the whole of `src/components/conversation/highlighted-command.tsx` with:

```tsx
import { useHighlightedTokens, TokenLine } from '@/components/code/highlighted-tokens';
import { cn } from '@/lib/utils';
import type { HighlightLanguage } from '@/renderer/file-display';

/** Code syntax-highlighted once the highlighter loads; plain text until then. Defaults to a shell command. */
export function HighlightedCommand({ command, language = 'bash', className }: { command: string; language?: HighlightLanguage; className?: string }) {
  const tokens = useHighlightedTokens(command, language);
  return (
    <pre className={cn('font-mono', className)}>
      {tokens
        ? tokens.map((line, lineIndex) => (
          <span key={lineIndex}>
            {lineIndex > 0 && '\n'}
            <TokenLine tokens={line} />
          </span>
        ))
        : command}
    </pre>
  );
}
```

- [ ] **Step 4: Run the full suite, lint, and typecheck**

Run: `pnpm test && pnpm lint && pnpm exec tsc --noEmit`
Expected: all pass. The existing `preview.test.ts`, `message-attachments.test.tsx`, and conversation tests prove there is no behaviour change.

- [ ] **Step 5: Commit**

```bash
git add src/main/text-file.ts src/main/text-file.test.ts src/main/attachments/preview.ts src/renderer/file-display.ts src/renderer/file-display.test.ts src/components/conversation/message-attachments.tsx src/components/code/highlighted-tokens.tsx src/components/conversation/highlighted-command.tsx
git commit -m "refactor: share text decoding, file display helpers, and token rendering

- move decodeText out of attachment previews into src/main/text-file.ts
- move basename, formatSize, and languageFor out of message-attachments into src/renderer/file-display.ts, and add absoluteProjectPath
- extract useHighlightedTokens and TokenLine from HighlightedCommand"
```

---

### Task 2: Files IPC contract

**Files:**
- Create: `src/shared/files-contract.ts`, `src/shared/files-contract.test.ts`

**Interfaces:**
- Produces (used by every later task): `FILES_CHANNELS`, `FILE_VIEW_MAX_BYTES`, `FILE_HIGHLIGHT_MAX_BYTES`, `FILE_LIST_MAX_ENTRIES`, `EDITOR_IDS`, `EditorId`, `FileOpenerId`, `OpenAction`, `FileEntry`, `FileContent`, `FileList`, `EditorInfo`, `OpenResult`, `FilesRequest`, `FilesEvent`, `FilesApi`, `parseFilesRequest(value: unknown): FilesRequest`, `parseFilesEvent(value: unknown): FilesEvent`

- [ ] **Step 1: Write the failing test**

`src/shared/files-contract.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { parseFilesEvent, parseFilesRequest } from './files-contract';

describe('files IPC contract', () => {
  test('accepts each valid request', () => {
    expect(parseFilesRequest({ method: 'listDirectory', root: '/repo', path: '' })).toEqual({ method: 'listDirectory', root: '/repo', path: '' });
    expect(parseFilesRequest({ method: 'readFile', root: '/repo', path: 'src/a.ts' })).toEqual({ method: 'readFile', root: '/repo', path: 'src/a.ts' });
    expect(parseFilesRequest({ method: 'listFiles', root: '/repo' })).toEqual({ method: 'listFiles', root: '/repo' });
    expect(parseFilesRequest({ method: 'watch', watchId: 'w1', root: '/repo', path: 'src' })).toEqual({ method: 'watch', watchId: 'w1', root: '/repo', path: 'src' });
    expect(parseFilesRequest({ method: 'unwatch', watchId: 'w1' })).toEqual({ method: 'unwatch', watchId: 'w1' });
    expect(parseFilesRequest({ method: 'editors' })).toEqual({ method: 'editors' });
    expect(parseFilesRequest({ method: 'open', action: 'zed', root: '/repo', path: 'a.ts', line: 12 })).toEqual({ method: 'open', action: 'zed', root: '/repo', path: 'a.ts', line: 12 });
    expect(parseFilesRequest({ method: 'open', action: 'reveal', root: '/repo', path: 'a.ts', line: undefined })).toEqual({ method: 'open', action: 'reveal', root: '/repo', path: 'a.ts' });
  });

  test.each([
    { method: 'listDirectory', root: 'relative', path: '' },
    { method: 'listDirectory', root: '/repo', path: '/etc' },
    { method: 'listDirectory', root: '/repo', path: '\\\\server\\share' },
    { method: 'listDirectory', root: '/repo', path: 'C:\\x' },
    { method: 'listDirectory', root: '/repo', path: 'a\0b' },
    { method: 'listDirectory', root: '/repo', path: 'x'.repeat(4097) },
    { method: 'readFile', root: '/repo', path: '' },
    { method: 'readFile', root: '/repo', path: 'a.ts', extra: true },
    { method: 'watch', watchId: '', root: '/repo', path: '' },
    { method: 'unwatch', watchId: 'x'.repeat(129) },
    { method: 'open', action: 'emacs', root: '/repo', path: 'a.ts' },
    { method: 'open', action: 'zed', root: '/repo', path: 'a.ts', line: 0 },
    { method: 'open', action: 'zed', root: '/repo', path: 'a.ts', line: 1.5 },
    { method: 'unknown' },
    null,
    [],
  ])('rejects malformed request %#', (request) => {
    expect(() => parseFilesRequest(request)).toThrow('Invalid files request');
  });

  test('parses change events, strips extra fields, and rejects anything else', () => {
    expect(parseFilesEvent({ type: 'changed', watchId: 'w1', extra: 1 })).toEqual({ type: 'changed', watchId: 'w1' });
    expect(() => parseFilesEvent({ type: 'changed', watchId: 7 })).toThrow('Invalid files event');
    expect(() => parseFilesEvent({ type: 'other', watchId: 'w1' })).toThrow('Invalid files event');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/shared/files-contract.test.ts`
Expected: FAIL, because `./files-contract` cannot be found.

- [ ] **Step 3: Implement the contract**

`src/shared/files-contract.ts`:

```ts
// Shared Files IPC contract, imported by main, preload, and renderer. No I/O.

export const FILES_CHANNELS = {
  invoke: 'fractal:files:invoke',
  event: 'fractal:files:event',
} as const;

/** Files above this are not sent to the renderer at all: Fractal's own bound on IPC size. A starting value. */
export const FILE_VIEW_MAX_BYTES = 2 * 1024 * 1024;
/** Above this a file is shown as plain text, because highlighting runs on the renderer's main thread. A starting value. */
export const FILE_HIGHLIGHT_MAX_BYTES = 256 * 1024;
/** The filter's file list stops here. A starting value. */
export const FILE_LIST_MAX_ENTRIES = 50_000;

export const EDITOR_IDS = ['vscode', 'cursor', 'zed', 'sublime'] as const;
export type EditorId = (typeof EDITOR_IDS)[number];
/** What the Open button remembers: an editor, or the OS default app. */
export type FileOpenerId = EditorId | 'system';
export type OpenAction = FileOpenerId | 'reveal';

export interface FileEntry {
  name: string;
  /** For a symlink, its target's kind; a broken link counts as a file. */
  kind: 'file' | 'directory';
  symlink: boolean;
  ignored: boolean;
  /** A symlink whose target is outside the project; it cannot be opened. */
  outside: boolean;
}

export type FileContent =
  | { kind: 'text'; content: string; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'too-large'; size: number }
  | { kind: 'missing' }
  | { kind: 'unreadable' };

/** Project-relative, '/'-separated paths for the filter. */
export interface FileList { paths: string[]; truncated: boolean }
export interface EditorInfo { id: EditorId; label: string }
export type OpenResult = { ok: true } | { ok: false; message: string };

export type FilesRequest =
  | { method: 'listDirectory'; root: string; path: string }
  | { method: 'readFile'; root: string; path: string }
  | { method: 'listFiles'; root: string }
  | { method: 'watch'; watchId: string; root: string; path: string }
  | { method: 'unwatch'; watchId: string }
  | { method: 'editors' }
  | { method: 'open'; action: OpenAction; root: string; path: string; line?: number };

export type FilesEvent = { type: 'changed'; watchId: string };

export interface FilesApi {
  listDirectory(root: string, path: string): Promise<FileEntry[]>;
  readFile(root: string, path: string): Promise<FileContent>;
  listFiles(root: string): Promise<FileList>;
  watch(watchId: string, root: string, path: string): Promise<void>;
  unwatch(watchId: string): Promise<void>;
  editors(): Promise<EditorInfo[]>;
  open(action: OpenAction, root: string, path: string, line?: number): Promise<OpenResult>;
  onEvent(listener: (event: FilesEvent) => void): () => void;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
const absolutePath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 32_768 &&
  (value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value));
// Relative to the project root; '' is the root itself. Main checks escapes again against the real filesystem.
const relativePath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 4096 && !value.includes('\0') &&
  !value.startsWith('/') && !value.startsWith('\\') && !/^[A-Za-z]:/.test(value);
const filePath = (value: unknown): value is string => relativePath(value) && value.length > 0;
const line = (value: unknown): value is number | undefined =>
  value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const ACTIONS: readonly string[] = [...EDITOR_IDS, 'system', 'reveal'];

export function parseFilesRequest(value: unknown): FilesRequest {
  if (object(value)) {
    const { method } = value;
    if (method === 'listDirectory' && absolutePath(value.root) && relativePath(value.path) && keys(value, ['method', 'root', 'path'])) {
      return { method, root: value.root, path: value.path };
    }
    if (method === 'readFile' && absolutePath(value.root) && filePath(value.path) && keys(value, ['method', 'root', 'path'])) {
      return { method, root: value.root, path: value.path };
    }
    if (method === 'listFiles' && absolutePath(value.root) && keys(value, ['method', 'root'])) {
      return { method, root: value.root };
    }
    if (method === 'watch' && id(value.watchId) && absolutePath(value.root) && relativePath(value.path) && keys(value, ['method', 'watchId', 'root', 'path'])) {
      return { method, watchId: value.watchId, root: value.root, path: value.path };
    }
    if (method === 'unwatch' && id(value.watchId) && keys(value, ['method', 'watchId'])) {
      return { method, watchId: value.watchId };
    }
    if (method === 'editors' && keys(value, ['method'])) return { method };
    if (method === 'open' && typeof value.action === 'string' && ACTIONS.includes(value.action) && absolutePath(value.root) &&
      filePath(value.path) && line(value.line) && keys(value, ['method', 'action', 'root', 'path', 'line'])) {
      return { method, action: value.action as OpenAction, root: value.root, path: value.path, ...(value.line === undefined ? {} : { line: value.line }) };
    }
  }
  throw new Error('Invalid files request');
}

export function parseFilesEvent(value: unknown): FilesEvent {
  if (object(value) && value.type === 'changed' && id(value.watchId)) return { type: 'changed', watchId: value.watchId };
  throw new Error('Invalid files event');
}
```

- [ ] **Step 4: Run the test, lint, and typecheck**

Run: `pnpm vitest run src/shared/files-contract.test.ts && pnpm lint && pnpm exec tsc --noEmit`
Expected: PASS. If `tsc` reports that `method` is not narrowed to a literal in a return, replace `method` in that return object with the literal (for example `method: 'listDirectory'`).

- [ ] **Step 5: Commit**

```bash
git add src/shared/files-contract.ts src/shared/files-contract.test.ts
git commit -m "feat(files): add the files IPC contract"
```

---

### Task 3: Project path confinement and git queries

**Files:**
- Create: `src/main/files/project-paths.ts`, `src/main/files/project-paths.test.ts`
- Create: `src/main/files/git.ts`, `src/main/files/git.test.ts`

**Interfaces:**
- Consumes: `FileList` from Task 2
- Produces: `class OutsideProjectError`, `isInside(parent: string, child: string): boolean`, `isMissing(error: unknown): boolean`, `resolveInProject(root: string, relative: string): Promise<{ realRoot: string; lexical: string; real: string }>`, `resolveParentInProject(root: string, relative: string): Promise<{ realParent: string; name: string }>`
- Produces: `runGit(cwd: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string }>`, `ignoredNames(directory: string, names: string[]): Promise<Set<string>>`, `listGitFiles(root: string, max: number): Promise<FileList | undefined>`

- [ ] **Step 1: Write the failing tests**

`src/main/files/project-paths.test.ts`:

```ts
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { isInside, isMissing, OutsideProjectError, resolveInProject, resolveParentInProject } from './project-paths';

let root: string;
let outside: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fractal-project-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'fractal-outside-')));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'a');
  await mkdir(join(root, 'node_modules', '.pnpm', 'react'), { recursive: true });
  await symlink(join(root, 'node_modules', '.pnpm', 'react'), join(root, 'node_modules', 'react'));
  await writeFile(join(outside, 'secret'), 's');
  await symlink(join(outside, 'secret'), join(root, 'leak'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('compares whole path segments', () => {
  expect(isInside('/repo', '/repo')).toBe(true);
  expect(isInside('/repo', '/repo/a')).toBe(true);
  expect(isInside('/repo', '/repo/..foo')).toBe(true);
  expect(isInside('/repo', '/repo-other')).toBe(false);
  expect(isInside('/repo', '/')).toBe(false);
});

test('resolves paths inside the project, including symlinks that stay inside', async () => {
  await expect(resolveInProject(root, '')).resolves.toEqual({ realRoot: root, lexical: root, real: root });
  await expect(resolveInProject(root, 'src/a.ts')).resolves.toMatchObject({ real: join(root, 'src', 'a.ts') });
  await expect(resolveInProject(root, 'node_modules/react')).resolves.toEqual({ realRoot: root, lexical: join(root, 'node_modules', 'react'), real: join(root, 'node_modules', '.pnpm', 'react') });
});

test('rejects ../ escapes and symlinks that lead out of the project', async () => {
  await expect(resolveInProject(root, '../x')).rejects.toBeInstanceOf(OutsideProjectError);
  await expect(resolveInProject(root, 'src/../../x')).rejects.toBeInstanceOf(OutsideProjectError);
  await expect(resolveInProject(root, 'leak')).rejects.toBeInstanceOf(OutsideProjectError);
});

test('reports a missing path as missing, but a missing path that escapes as outside', async () => {
  expect(isMissing(await resolveInProject(root, 'src/gone.ts').catch((error: unknown) => error))).toBe(true);
  expect(isMissing(await resolveInProject(root, 'src/a.ts/x').catch((error: unknown) => error))).toBe(true);
  await expect(resolveInProject(root, '../gone')).rejects.toBeInstanceOf(OutsideProjectError);
});

test('resolves the folder of a file that may not exist', async () => {
  await expect(resolveParentInProject(root, 'src/new.ts')).resolves.toEqual({ realParent: join(root, 'src'), name: 'new.ts' });
  await expect(resolveParentInProject(root, '')).rejects.toBeInstanceOf(OutsideProjectError);
  await expect(resolveParentInProject(root, '../x')).rejects.toBeInstanceOf(OutsideProjectError);
});
```

`src/main/files/git.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ignoredNames, listGitFiles } from './git';

let root: string;
let plain: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fractal-git-')));
  plain = await realpath(await mkdtemp(join(tmpdir(), 'fractal-plain-')));
  execFileSync('git', ['-C', root, 'init', '-q']);
  await writeFile(join(root, '.gitignore'), 'out/\n*.log\n');
  await mkdir(join(root, 'out'));
  await writeFile(join(root, 'out', 'c.js'), 'c');
  await writeFile(join(root, 'a.log'), 'log');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'b.ts'), 'b');
  await writeFile(join(root, 'README.md'), 'r');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(plain, { recursive: true, force: true });
});

test('names the ignored files and folders in a repository directory', async () => {
  expect(await ignoredNames(root, ['out', 'a.log', 'src', 'README.md'])).toEqual(new Set(['out', 'a.log']));
  expect(await ignoredNames(join(root, 'src'), ['b.ts'])).toEqual(new Set());
  expect(await ignoredNames(root, [])).toEqual(new Set());
});

test('ignores nothing outside a repository', async () => {
  await writeFile(join(plain, 'x.log'), 'x');
  expect(await ignoredNames(plain, ['x.log'])).toEqual(new Set());
});

test('lists tracked and untracked files but not ignored ones', async () => {
  const list = await listGitFiles(root, 100);
  expect(list?.truncated).toBe(false);
  expect(list?.paths.sort()).toEqual(['.gitignore', 'README.md', 'src/b.ts']);
});

test('stops listing at the cap and says so', async () => {
  const list = await listGitFiles(root, 2);
  expect(list).toMatchObject({ truncated: true });
  expect(list?.paths).toHaveLength(2);
});

test('lists nothing outside a repository', async () => {
  expect(await listGitFiles(plain, 100)).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/files/project-paths.test.ts src/main/files/git.test.ts`
Expected: FAIL, because the modules cannot be found.

- [ ] **Step 3: Implement the modules**

`src/main/files/project-paths.ts`:

```ts
import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** A request named a path that leads out of its project. */
export class OutsideProjectError extends Error {
  override name = 'OutsideProjectError';
}

/** Whether `child` is `parent` or inside it. Both must be absolute and normalised. */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Whether a filesystem error means the path does not exist (or something on the way is a file). */
export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Resolves a project-relative path. `lexical` is the path joined onto the
 * project's real root; `real` also follows every symlink. Both must stay
 * inside the root, so neither `../` nor a symlink leads out of the project.
 * Rejects with the filesystem's error (see `isMissing`) when the path does
 * not exist, after the lexical check, so a missing path that escapes is
 * still reported as outside.
 */
export async function resolveInProject(root: string, relative: string): Promise<{ realRoot: string; lexical: string; real: string }> {
  const realRoot = await realpath(root);
  const lexical = path.resolve(realRoot, relative);
  if (!isInside(realRoot, lexical)) throw new OutsideProjectError('Path is outside the project');
  const real = await realpath(lexical);
  if (!isInside(realRoot, real)) throw new OutsideProjectError('Path is outside the project');
  return { realRoot, lexical, real };
}

/** For a file that may not exist: its folder's real path, which must be inside the project, and its own name. */
export async function resolveParentInProject(root: string, relative: string): Promise<{ realParent: string; name: string }> {
  const realRoot = await realpath(root);
  const lexical = path.resolve(realRoot, relative);
  if (lexical === realRoot || !isInside(realRoot, lexical)) throw new OutsideProjectError('Path is outside the project');
  const realParent = await realpath(path.dirname(lexical));
  if (!isInside(realRoot, realParent)) throw new OutsideProjectError('Path is outside the project');
  return { realParent, name: path.basename(lexical) };
}
```

`src/main/files/git.ts`:

```ts
import { spawn } from 'node:child_process';
import type { FileList } from '@/shared/files-contract';

// Read at call time: main adds the login shell's PATH after this module loads.
// GIT_OPTIONAL_LOCKS=0 keeps these read-only queries from taking the index lock.
const gitEnvironment = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0' });

/** Runs git in `cwd`. Resolves with a null code when git could not be started. */
export function runGit(cwd: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', cwd, ...args], { shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: gitEnvironment() });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.once('error', () => resolve({ code: null, stdout: '' }));
    child.once('close', (code) => resolve({ code, stdout }));
    // git can exit before reading all of stdin; the exit code still says what happened.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}

/** Which of `names` in `directory` git ignores; none outside a repository or without git. */
export async function ignoredNames(directory: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const { code, stdout } = await runGit(directory, ['check-ignore', '--stdin', '-z'], `${names.join('\0')}\0`);
  // 0: some are ignored. 1: none are. 128: not a repository. null: git did not start.
  return code === 0 ? new Set(stdout.split('\0').filter(Boolean)) : new Set();
}

/**
 * Tracked files and untracked files that are not ignored, relative to `root`
 * and '/'-separated; undefined outside a repository or without git. Stops
 * reading after `max` paths.
 */
export function listGitFiles(root: string, max: number): Promise<FileList | undefined> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: gitEnvironment() });
    const paths = new Set<string>();
    let pending = '';
    let truncated = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (truncated) return;
      const parts = `${pending}${chunk}`.split('\0');
      pending = parts.pop() ?? '';
      for (const part of parts) {
        if (!part) continue;
        if (paths.size >= max) { truncated = true; child.kill(); return; }
        paths.add(part);
      }
    });
    child.once('error', () => resolve(undefined));
    child.once('close', (code) => resolve(truncated || code === 0 ? { paths: [...paths], truncated } : undefined));
  });
}
```

- [ ] **Step 4: Run the tests, lint, and typecheck**

Run: `pnpm vitest run src/main/files && pnpm lint && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/files/project-paths.ts src/main/files/project-paths.test.ts src/main/files/git.ts src/main/files/git.test.ts
git commit -m "feat(files): confine paths to their project and query git for ignores and files"
```

---

### Task 4: File service

**Files:**
- Create: `src/main/files/file-service.ts`, `src/main/files/file-service.test.ts`

**Interfaces:**
- Consumes: `resolveInProject`, `isInside`, `isMissing`, `OutsideProjectError` (Task 3); `ignoredNames`, `listGitFiles` (Task 3); `decodeText` (Task 1); `FileEntry`, `FileContent`, `FileList`, `FILE_VIEW_MAX_BYTES`, `FILE_LIST_MAX_ENTRIES` (Task 2)
- Produces: `listDirectory(root: string, relative: string): Promise<FileEntry[]>`, `readProjectFile(root: string, relative: string): Promise<FileContent>`, `listProjectFiles(root: string, max?: number): Promise<FileList>`

- [ ] **Step 1: Write the failing test**

`src/main/files/file-service.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FILE_VIEW_MAX_BYTES } from '@/shared/files-contract';
import { listDirectory, listProjectFiles, readProjectFile } from './file-service';
import { OutsideProjectError } from './project-paths';

let root: string;
let outside: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fractal-files-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'fractal-outside-')));
  execFileSync('git', ['-C', root, 'init', '-q']);
  await writeFile(join(root, '.gitignore'), 'out/\n');
  await mkdir(join(root, 'out'));
  await writeFile(join(root, 'out', 'built.js'), 'x');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'a2.txt'), '2');
  await writeFile(join(root, 'a10.txt'), '10');
  await writeFile(join(root, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]));
  await writeFile(join(root, 'big.txt'), Buffer.alloc(FILE_VIEW_MAX_BYTES + 1, 0x61));
  await writeFile(join(outside, 'secret'), 's');
  await symlink(join(outside, 'secret'), join(root, 'leak'));
  await symlink(join(root, 'src'), join(root, 'src-link'));
  await symlink(join(root, 'nowhere'), join(root, 'dangling'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('listDirectory', () => {
  test('lists folders first in natural order, hides .git, and marks ignored entries and links', async () => {
    const entries = await listDirectory(root, '');
    const names = entries.map((entry) => entry.name);
    expect(names.slice(0, 3)).toEqual(['out', 'src', 'src-link']);
    expect(names.indexOf('a2.txt')).toBeLessThan(names.indexOf('a10.txt'));
    expect(names).not.toContain('.git');
    expect(entries.find((entry) => entry.name === 'out')).toMatchObject({ kind: 'directory', ignored: true });
    expect(entries.find((entry) => entry.name === 'src')).toMatchObject({ kind: 'directory', ignored: false, symlink: false });
    expect(entries.find((entry) => entry.name === 'src-link')).toMatchObject({ kind: 'directory', symlink: true, outside: false });
    expect(entries.find((entry) => entry.name === 'leak')).toMatchObject({ kind: 'file', symlink: true, outside: true });
    expect(entries.find((entry) => entry.name === 'dangling')).toMatchObject({ kind: 'file', symlink: true, outside: false });
  });

  test('marks nothing ignored outside a repository', async () => {
    await rm(join(root, '.git'), { recursive: true, force: true });
    expect((await listDirectory(root, '')).find((entry) => entry.name === 'out')?.ignored).toBe(false);
  });

  test('refuses a folder outside the project', async () => {
    await expect(listDirectory(root, '..')).rejects.toBeInstanceOf(OutsideProjectError);
  });
});

describe('readProjectFile', () => {
  test('returns text, binary, and too-large files', async () => {
    await expect(readProjectFile(root, 'src/a.ts')).resolves.toEqual({ kind: 'text', content: 'export const a = 1;\n', size: 20 });
    await expect(readProjectFile(root, 'bin.dat')).resolves.toEqual({ kind: 'binary', size: 3 });
    await expect(readProjectFile(root, 'big.txt')).resolves.toEqual({ kind: 'too-large', size: FILE_VIEW_MAX_BYTES + 1 });
  });

  test('reports missing and unreadable paths instead of failing', async () => {
    await expect(readProjectFile(root, 'src/gone.ts')).resolves.toEqual({ kind: 'missing' });
    await expect(readProjectFile(root, 'dangling')).resolves.toEqual({ kind: 'missing' });
    await expect(readProjectFile(root, 'src')).resolves.toEqual({ kind: 'unreadable' });
  });

  test('refuses files outside the project', async () => {
    await expect(readProjectFile(root, 'leak')).rejects.toBeInstanceOf(OutsideProjectError);
    await expect(readProjectFile(root, '../secret')).rejects.toBeInstanceOf(OutsideProjectError);
  });
});

describe('listProjectFiles', () => {
  test('uses git in a repository, leaving out ignored files', async () => {
    const list = await listProjectFiles(root);
    expect(list.truncated).toBe(false);
    expect(list.paths).toContain('src/a.ts');
    expect(list.paths).not.toContain('out/built.js');
  });

  test('walks a folder that is not a repository, skipping .git and stopping at the cap', async () => {
    await rm(join(root, '.git'), { recursive: true, force: true });
    const all = await listProjectFiles(root);
    expect(all.paths).toContain('out/built.js');
    expect(all.paths).toContain('src/a.ts');
    expect(await listProjectFiles(root, 2)).toMatchObject({ truncated: true, paths: expect.any(Array) });
    expect((await listProjectFiles(root, 2)).paths).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/main/files/file-service.test.ts`
Expected: FAIL, because `./file-service` cannot be found.

- [ ] **Step 3: Implement the service**

`src/main/files/file-service.ts`:

```ts
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeText } from '@/main/text-file';
import { FILE_LIST_MAX_ENTRIES, FILE_VIEW_MAX_BYTES, type FileContent, type FileEntry, type FileList } from '@/shared/files-contract';
import { ignoredNames, listGitFiles } from './git';
import { isInside, isMissing, OutsideProjectError, resolveInProject } from './project-paths';

const compareEntries = (a: FileEntry, b: FileEntry): number =>
  a.kind === b.kind
    ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    : a.kind === 'directory' ? -1 : 1;

/** A folder's entries, folders first; `.git` is never listed. */
export async function listDirectory(root: string, relative: string): Promise<FileEntry[]> {
  const { realRoot, real: directory } = await resolveInProject(root, relative);
  const dirents = (await readdir(directory, { withFileTypes: true })).filter((dirent) => dirent.name !== '.git');
  const entries = await Promise.all(dirents.map(async (dirent): Promise<Omit<FileEntry, 'ignored'>> => {
    if (!dirent.isSymbolicLink()) {
      return { name: dirent.name, kind: dirent.isDirectory() ? 'directory' : 'file', symlink: false, outside: false };
    }
    try {
      const target = await realpath(path.join(directory, dirent.name));
      return { name: dirent.name, kind: (await stat(target)).isDirectory() ? 'directory' : 'file', symlink: true, outside: !isInside(realRoot, target) };
    } catch {
      // A broken link: listed as a file, which then reads as missing.
      return { name: dirent.name, kind: 'file', symlink: true, outside: false };
    }
  }));
  const ignored = await ignoredNames(directory, entries.map((entry) => entry.name));
  return entries.map((entry) => ({ ...entry, ignored: ignored.has(entry.name) })).sort(compareEntries);
}

/** A file's contents for the viewer, or why there are none. Throws only for a path outside the project. */
export async function readProjectFile(root: string, relative: string): Promise<FileContent> {
  try {
    const { real } = await resolveInProject(root, relative);
    const info = await stat(real);
    if (!info.isFile()) return { kind: 'unreadable' };
    if (info.size > FILE_VIEW_MAX_BYTES) return { kind: 'too-large', size: info.size };
    const bytes = await readFile(real);
    // It may have grown since the stat.
    if (bytes.length > FILE_VIEW_MAX_BYTES) return { kind: 'too-large', size: bytes.length };
    const content = decodeText(bytes);
    return content === undefined ? { kind: 'binary', size: bytes.length } : { kind: 'text', content, size: bytes.length };
  } catch (error) {
    if (error instanceof OutsideProjectError) throw error;
    return isMissing(error) ? { kind: 'missing' } : { kind: 'unreadable' };
  }
}

/** Every file the filter searches: git's list in a repository, otherwise a capped walk. */
export async function listProjectFiles(root: string, max = FILE_LIST_MAX_ENTRIES): Promise<FileList> {
  const realRoot = await realpath(root);
  return (await listGitFiles(realRoot, max)) ?? walkFiles(realRoot, max);
}

async function walkFiles(root: string, max: number): Promise<FileList> {
  const paths: string[] = [];
  const folders = [''];
  for (let index = 0; index < folders.length; index++) {
    const folder = folders[index];
    let dirents;
    try { dirents = await readdir(path.join(root, folder), { withFileTypes: true }); } catch { continue; }
    for (const dirent of dirents) {
      if (dirent.name === '.git') continue;
      const child = folder ? `${folder}/${dirent.name}` : dirent.name;
      // Symlinked folders are not followed, so a link cycle cannot loop the walk.
      if (dirent.isDirectory()) { folders.push(child); continue; }
      if (paths.length >= max) return { paths, truncated: true };
      paths.push(child);
    }
  }
  return { paths, truncated: false };
}
```

- [ ] **Step 4: Run the test, lint, and typecheck**

Run: `pnpm vitest run src/main/files && pnpm lint && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/files/file-service.ts src/main/files/file-service.test.ts
git commit -m "feat(files): list folders, read files, and list a project's files"
```

---

### Task 5: Watch service

**Files:**
- Create: `src/main/files/file-watch-service.ts`, `src/main/files/file-watch-service.test.ts`

**Interfaces:**
- Consumes: `resolveInProject`, `resolveParentInProject`, `isMissing`, `OutsideProjectError` (Task 3); `FilesEvent` (Task 2)
- Produces: `type DirectoryWatcher = (directory: string, onChange: (name: string | null) => void) => { close(): void }`, `nodeDirectoryWatcher`, `class FileWatchService { constructor(watchDirectory?: DirectoryWatcher, debounceMs?: number); watch(owner: object, watchId: string, root: string, relative: string, emit: (event: FilesEvent) => void): Promise<void>; unwatch(owner: object, watchId: string): void; closeOwner(owner: object): void; dispose(): void }`

- [ ] **Step 1: Write the failing test**

`src/main/files/file-watch-service.test.ts`:

```ts
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { FilesEvent } from '@/shared/files-contract';
import { FileWatchService, type DirectoryWatcher } from './file-watch-service';
import { OutsideProjectError } from './project-paths';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fractal-watch-')));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'a');
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

function fakeWatcher() {
  const watched: Array<{ directory: string; onChange: (name: string | null) => void; closed: boolean }> = [];
  const factory: DirectoryWatcher = (directory, onChange) => {
    const entry = { directory, onChange, closed: false };
    watched.push(entry);
    return { close: () => { entry.closed = true; } };
  };
  return { watched, factory };
}
const noop = () => undefined;

test('watches a folder directly and a file through its folder, filtered to its name and debounced', async () => {
  const f = fakeWatcher();
  const service = new FileWatchService(f.factory, 100);
  const events: FilesEvent[] = [];
  await service.watch({}, 'dir', root, 'src', (event) => events.push(event));
  await service.watch({}, 'file', root, 'src/a.ts', (event) => events.push(event));
  expect(f.watched.map((entry) => entry.directory)).toEqual([join(root, 'src'), join(root, 'src')]);
  vi.useFakeTimers();
  f.watched[1].onChange('b.ts');
  vi.advanceTimersByTime(100);
  expect(events).toEqual([]);
  f.watched[1].onChange('a.ts');
  f.watched[1].onChange('a.ts');
  vi.advanceTimersByTime(99);
  expect(events).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(events).toEqual([{ type: 'changed', watchId: 'file' }]);
  f.watched[0].onChange('anything');
  f.watched[1].onChange(null);
  vi.advanceTimersByTime(100);
  expect(events).toEqual([{ type: 'changed', watchId: 'file' }, { type: 'changed', watchId: 'dir' }, { type: 'changed', watchId: 'file' }]);
});

test('watches a missing file through its folder, so its return is noticed', async () => {
  const f = fakeWatcher();
  const service = new FileWatchService(f.factory, 0);
  const events: FilesEvent[] = [];
  await service.watch({}, 'new', root, 'src/new.ts', (event) => events.push(event));
  expect(f.watched[0].directory).toBe(join(root, 'src'));
  f.watched[0].onChange('new.ts');
  await vi.waitFor(() => expect(events).toEqual([{ type: 'changed', watchId: 'new' }]));
});

test('keeps watches per owner and closes them all with their owner', async () => {
  const f = fakeWatcher();
  const service = new FileWatchService(f.factory, 0);
  const owner = {};
  await service.watch(owner, 'one', root, 'src', noop);
  await expect(service.watch(owner, 'one', root, 'src', noop)).rejects.toThrow('Watch already exists');
  expect(() => service.unwatch({}, 'one')).toThrow('Watch belongs to another owner');
  await service.watch(owner, 'two', root, '', noop);
  service.closeOwner(owner);
  expect(f.watched.every((entry) => entry.closed)).toBe(true);
  expect(() => service.unwatch(owner, 'one')).not.toThrow();
});

test('an unwatch during setup leaves nothing running', async () => {
  const f = fakeWatcher();
  const service = new FileWatchService(f.factory, 0);
  const owner = {};
  const pending = service.watch(owner, 'one', root, 'src', noop);
  service.unwatch(owner, 'one');
  await pending;
  expect(f.watched).toEqual([]);
});

test('refuses paths outside the project', async () => {
  const service = new FileWatchService(fakeWatcher().factory, 0);
  await expect(service.watch({}, 'x', root, '../x', noop)).rejects.toBeInstanceOf(OutsideProjectError);
});

test('reports a temp-file-and-rename save through a real folder watch', async () => {
  const service = new FileWatchService(undefined, 20);
  const events: FilesEvent[] = [];
  await service.watch({}, 'file', root, 'src/a.ts', (event) => events.push(event));
  await writeFile(join(root, 'src', '.a.ts.tmp'), 'new');
  await rename(join(root, 'src', '.a.ts.tmp'), join(root, 'src', 'a.ts'));
  await vi.waitFor(() => expect(events).toContainEqual({ type: 'changed', watchId: 'file' }));
  service.dispose();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/main/files/file-watch-service.test.ts`
Expected: FAIL, because `./file-watch-service` cannot be found.

- [ ] **Step 3: Implement the service**

`src/main/files/file-watch-service.ts`:

```ts
import { watch as watchFolder } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FilesEvent } from '@/shared/files-contract';
import { isMissing, OutsideProjectError, resolveInProject, resolveParentInProject } from './project-paths';

/** Watches one folder and reports the name of whatever changed in it, or null when the platform does not say. */
export type DirectoryWatcher = (directory: string, onChange: (name: string | null) => void) => { close(): void };

export const nodeDirectoryWatcher: DirectoryWatcher = (directory, onChange) => {
  const watcher = watchFolder(directory, { persistent: false }, (_type, name) => onChange(name === null ? null : String(name)));
  // A watched folder that disappears errors on some platforms; the watch simply stops reporting.
  watcher.on('error', () => watcher.close());
  return watcher;
};

type Watch = { owner: object; close: () => void; timer?: ReturnType<typeof setTimeout> };

/**
 * Change notifications for the folders and files the renderer is showing. A
 * folder is watched directly. A file is watched through its folder, filtered
 * to its name, because a save that writes a temporary file and renames it
 * over the original replaces the file a direct watch would follow. A burst of
 * changes becomes one event. Each watch belongs to the owner that made it.
 */
export class FileWatchService {
  private readonly watches = new Map<string, Watch>();
  private disposed = false;

  constructor(private readonly watchDirectory: DirectoryWatcher = nodeDirectoryWatcher, private readonly debounceMs = 100) {}

  async watch(owner: object, watchId: string, root: string, relative: string, emit: (event: FilesEvent) => void): Promise<void> {
    if (this.disposed || this.watches.has(watchId)) throw new Error('Watch already exists');
    // Reserved before the first await, so an unwatch during setup is seen.
    const entry: Watch = { owner, close: () => undefined };
    this.watches.set(watchId, entry);
    try {
      const { directory, name } = await this.target(root, relative);
      if (this.watches.get(watchId) !== entry) return;
      const watcher = this.watchDirectory(directory, (changed) => {
        if (name !== undefined && changed !== null && changed !== name) return;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          if (this.watches.get(watchId) === entry) emit({ type: 'changed', watchId });
        }, this.debounceMs);
      });
      entry.close = () => { clearTimeout(entry.timer); watcher.close(); };
    } catch (error) {
      if (this.watches.get(watchId) === entry) this.watches.delete(watchId);
      throw error;
    }
  }

  unwatch(owner: object, watchId: string): void {
    const entry = this.watches.get(watchId);
    if (!entry) return;
    if (entry.owner !== owner) throw new Error('Watch belongs to another owner');
    this.watches.delete(watchId);
    entry.close();
  }

  closeOwner(owner: object): void {
    for (const [watchId, entry] of this.watches) {
      if (entry.owner !== owner) continue;
      this.watches.delete(watchId);
      entry.close();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.watches.values()) entry.close();
    this.watches.clear();
  }

  private async target(root: string, relative: string): Promise<{ directory: string; name?: string }> {
    try {
      const { real } = await resolveInProject(root, relative);
      return (await stat(real)).isDirectory() ? { directory: real } : { directory: path.dirname(real), name: path.basename(real) };
    } catch (error) {
      if (error instanceof OutsideProjectError || !isMissing(error)) throw error;
    }
    // A file that does not exist (yet, or any more) is watched through its folder, so its return is noticed.
    const { realParent, name } = await resolveParentInProject(root, relative);
    return { directory: realParent, name };
  }
}
```

- [ ] **Step 4: Run the test, lint, and typecheck**

Run: `pnpm vitest run src/main/files && pnpm lint && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/files/file-watch-service.ts src/main/files/file-watch-service.test.ts
git commit -m "feat(files): watch folders and files for changes, per owner"
```

---

### Task 6: Editor detection and launch, and the `fileOpener` setting

**Files:**
- Create: `src/main/files/editors.ts`, `src/main/files/editors.test.ts`
- Modify: `src/shared/settings-contract.ts`, `src/main/settings-store.ts`, `src/main/settings-ipc.ts`
- Modify: `src/main/settings-store.test.ts`, plus every test fixture that builds a full `FractalSettings` (find them with `grep -rln "agentExecutables: {" src`; today that is `src/main/settings-store.test.ts`, `src/components/app-shell.test.tsx`, and `src/components/settings-dialog.test.tsx`)

**Interfaces:**
- Consumes: `EDITOR_IDS`, `EditorId`, `EditorInfo`, `FileOpenerId`, `OpenAction`, `OpenResult` (Task 2)
- Produces: `EDITORS: Record<EditorId, { label: string; command: string; args(root: string, file: string, line?: number): string[] }>`, `interface DetectedEditor extends EditorInfo { executable: string }`, `detectEditors(platform: NodeJS.Platform, searchPath: string, isExecutable?: (file: string) => Promise<boolean>): Promise<DetectedEditor[]>`, `interface OpenerShell { openPath(path: string): Promise<string>; showItemInFolder(path: string): void }`, `type Spawn`, `openWith(action: OpenAction, target: { root: string; file: string; line?: number }, deps: { editors: () => Promise<DetectedEditor[]>; shell: OpenerShell; spawnProcess?: Spawn }): Promise<OpenResult>`
- Produces: `FractalSettings.fileOpener: FileOpenerId | null`

- [ ] **Step 1: Write the failing tests**

`src/main/files/editors.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { detectEditors, EDITORS, openWith, type DetectedEditor, type Spawn } from './editors';

const zed: DetectedEditor = { id: 'zed', label: 'Zed', executable: '/bin/zed' };
const shell = () => ({ openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() });
function spawned(event: 'spawn' | 'error') {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const spawnProcess = vi.fn(() => { queueMicrotask(() => child.emit(event, new Error('no'))); return child; });
  return { child, spawnProcess: spawnProcess as unknown as Spawn & typeof spawnProcess };
}

test('builds each editor\'s arguments with and without a line', () => {
  expect(EDITORS.vscode.args('/repo', '/repo/a.ts', 12)).toEqual(['/repo', '-g', '/repo/a.ts:12']);
  expect(EDITORS.cursor.args('/repo', '/repo/a.ts')).toEqual(['/repo', '-g', '/repo/a.ts']);
  expect(EDITORS.zed.args('/repo', '/repo/a.ts', 3)).toEqual(['/repo/a.ts:3']);
  expect(EDITORS.sublime.args('/repo', '/repo/a.ts')).toEqual(['/repo/a.ts']);
});

test('detects editors on the search path in menu order, and none on Windows', async () => {
  const present = new Set(['/home/me/.local/bin/zed', '/usr/bin/code', '/opt/code']);
  const isExecutable = async (file: string) => present.has(file);
  expect(await detectEditors('linux', '/usr/bin:/home/me/.local/bin:/opt', isExecutable)).toEqual([
    { id: 'vscode', label: 'VS Code', executable: '/usr/bin/code' },
    { id: 'zed', label: 'Zed', executable: '/home/me/.local/bin/zed' },
  ]);
  expect(await detectEditors('darwin', '/usr/bin', isExecutable)).toHaveLength(1);
  expect(await detectEditors('win32', '/usr/bin', isExecutable)).toEqual([]);
});

test('starts a detected editor detached, with no shell, and lets it outlive Fractal', async () => {
  const { child, spawnProcess } = spawned('spawn');
  const result = await openWith('zed', { root: '/repo', file: '/repo/a.ts', line: 4 }, { editors: async () => [zed], shell: shell(), spawnProcess });
  expect(result).toEqual({ ok: true });
  expect(spawnProcess).toHaveBeenCalledWith('/bin/zed', ['/repo/a.ts:4'], { detached: true, stdio: 'ignore', shell: false });
  expect(child.unref).toHaveBeenCalled();
});

test('reports an editor that is not detected or fails to start', async () => {
  const { spawnProcess } = spawned('error');
  expect(await openWith('zed', { root: '/repo', file: '/repo/a.ts' }, { editors: async () => [zed], shell: shell(), spawnProcess })).toEqual({ ok: false, message: 'Couldn\'t start Zed' });
  expect(await openWith('vscode', { root: '/repo', file: '/repo/a.ts' }, { editors: async () => [zed], shell: shell(), spawnProcess })).toEqual({ ok: false, message: 'VS Code isn\'t available' });
});

test('opens with the default app or shows the file in its folder', async () => {
  const s = shell();
  expect(await openWith('system', { root: '/repo', file: '/repo/a.ts' }, { editors: async () => [], shell: s })).toEqual({ ok: true });
  expect(s.openPath).toHaveBeenCalledWith('/repo/a.ts');
  s.openPath.mockResolvedValue('No application is registered');
  expect(await openWith('system', { root: '/repo', file: '/repo/a.ts' }, { editors: async () => [], shell: s })).toEqual({ ok: false, message: 'Couldn\'t open this file with the default app' });
  expect(await openWith('reveal', { root: '/repo', file: '/repo/a.ts' }, { editors: async () => [], shell: s })).toEqual({ ok: true });
  expect(s.showItemInFolder).toHaveBeenCalledWith('/repo/a.ts');
});
```

Add to `src/main/settings-store.test.ts`:

```ts
test('persists the file opener and drops unknown ones', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-'));
  dirs.push(dir);
  const store = new SettingsStore(dir);
  expect(store.load().fileOpener).toBeNull();
  store.save({ ...store.load(), fileOpener: 'zed' });
  expect(new SettingsStore(dir).load().fileOpener).toBe('zed');
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ fileOpener: 'emacs' }));
  expect(new SettingsStore(dir).load().fileOpener).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/files/editors.test.ts src/main/settings-store.test.ts`
Expected: FAIL. `./editors` is missing, and `fileOpener` is `undefined` rather than `null`.

- [ ] **Step 3: Implement editors and the setting**

`src/main/files/editors.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { EDITOR_IDS, type EditorId, type EditorInfo, type OpenAction, type OpenResult } from '@/shared/files-contract';

interface EditorSpec { label: string; command: string; args(root: string, file: string, line?: number): string[] }

const at = (file: string, line?: number) => (line === undefined ? file : `${file}:${line}`);
// Given the project folder too, these open the file in the window that has the project open.
const vscodeArgs = (root: string, file: string, line?: number) => [root, '-g', at(file, line)];

/** The editors Fractal can hand a file to, in menu order. */
export const EDITORS: Record<EditorId, EditorSpec> = {
  vscode: { label: 'VS Code', command: 'code', args: vscodeArgs },
  cursor: { label: 'Cursor', command: 'cursor', args: vscodeArgs },
  zed: { label: 'Zed', command: 'zed', args: (_root, file, line) => [at(file, line)] },
  sublime: { label: 'Sublime Text', command: 'subl', args: (_root, file, line) => [at(file, line)] },
};

export interface DetectedEditor extends EditorInfo { executable: string }

const isExecutableFile = async (file: string): Promise<boolean> => {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch { return false; }
};

/**
 * The editors whose command is on `searchPath`, in menu order. None on
 * Windows: editor launchers there are .cmd batch files, which Node will not
 * start without a shell, and a shell would interpret characters in file names.
 */
export async function detectEditors(platform: NodeJS.Platform, searchPath: string, isExecutable = isExecutableFile): Promise<DetectedEditor[]> {
  if (platform === 'win32') return [];
  const directories = searchPath.split(path.delimiter).filter(Boolean);
  const found: DetectedEditor[] = [];
  for (const id of EDITOR_IDS) {
    const { label, command } = EDITORS[id];
    for (const directory of directories) {
      const executable = path.join(directory, command);
      if (await isExecutable(executable)) { found.push({ id, label, executable }); break; }
    }
  }
  return found;
}

export type Spawn = typeof spawn;
export interface OpenerShell { openPath(path: string): Promise<string>; showItemInFolder(path: string): void }

/** Starts an editor detached from Fractal, with no shell. Resolves true once the process is running. */
function launch(editor: DetectedEditor, root: string, file: string, line: number | undefined, spawnProcess: Spawn): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(editor.executable, EDITORS[editor.id].args(root, file, line), { detached: true, stdio: 'ignore', shell: false });
    } catch { resolve(false); return; }
    child.once('spawn', () => { child.unref(); resolve(true); });
    child.once('error', () => resolve(false));
  });
}

/** Opens `target.file`, already confined to `target.root`, the way the user chose. */
export async function openWith(action: OpenAction, target: { root: string; file: string; line?: number }, deps: { editors: () => Promise<DetectedEditor[]>; shell: OpenerShell; spawnProcess?: Spawn }): Promise<OpenResult> {
  if (action === 'reveal') {
    deps.shell.showItemInFolder(target.file);
    return { ok: true };
  }
  if (action === 'system') {
    return (await deps.shell.openPath(target.file)) === '' ? { ok: true } : { ok: false, message: 'Couldn\'t open this file with the default app' };
  }
  const { label } = EDITORS[action];
  const editor = (await deps.editors()).find((candidate) => candidate.id === action);
  if (!editor) return { ok: false, message: `${label} isn't available` };
  return (await launch(editor, target.root, target.file, target.line, deps.spawnProcess ?? spawn)) ? { ok: true } : { ok: false, message: `Couldn't start ${label}` };
}
```

In `src/shared/settings-contract.ts`, add the import at the top and the field at the end of `FractalSettings`:

```ts
import type { FileOpenerId } from '@/shared/files-contract';
```

```ts
  /** What the Files viewer's Open button runs; null until the user has opened a file with something. */
  fileOpener: FileOpenerId | null;
```

In `src/main/settings-store.ts`:
- Add `import { EDITOR_IDS, type FileOpenerId } from '@/shared/files-contract';`.
- Add `fileOpener: null` to the object returned by `defaults()`.
- Add the coercion beside the others:

```ts
const FILE_OPENER_VALUES: readonly string[] = [...EDITOR_IDS, 'system'];

function coerceFileOpener(value: unknown): FileOpenerId | null {
  return typeof value === 'string' && FILE_OPENER_VALUES.includes(value) ? (value as FileOpenerId) : null;
}
```

- Add `fileOpener: coerceFileOpener(record.fileOpener),` to the object returned by `coerceSettings`.

In `src/main/settings-ipc.ts`, add to `sanitizePatch`:

```ts
    ...(patch.fileOpener !== undefined ? { fileOpener: patch.fileOpener } : {}),
```

Add `fileOpener: null` to every full `FractalSettings` literal in the fixtures from `grep -rln "agentExecutables: {" src` (including both `toEqual` expectations and the `store.save` call in `settings-store.test.ts`). `tsc` lists any you miss.

- [ ] **Step 4: Run the full suite, lint, and typecheck**

Run: `pnpm test && pnpm lint && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/files/editors.ts src/main/files/editors.test.ts src/shared/settings-contract.ts src/main/settings-store.ts src/main/settings-ipc.ts src/main/settings-store.test.ts src/components/app-shell.test.tsx src/components/settings-dialog.test.tsx
git commit -m "feat(files): detect and launch editors, and remember the file opener

- detect VS Code, Cursor, Zed, and Sublime Text on PATH on Linux and macOS, none on Windows
- launch editors detached with a fixed argument list and no shell
- open with the default app or show in folder through Electron's shell
- add a fileOpener setting that drops unknown values"
```

---

### Task 7: Files IPC, known projects, preload, and main wiring

**Files:**
- Create: `src/main/ipc-owners.ts`, `src/main/ipc-owners.test.ts`
- Modify: `src/main/terminal-ipc.ts`
- Modify: `src/main/conversation-registry.ts`, `src/main/conversation-registry.test.ts`, `src/main/conversation-service.ts`, `src/main/conversation-service.test.ts`
- Create: `src/main/files/files-ipc.ts`, `src/main/files/files-ipc.test.ts`
- Modify: `src/preload.ts`, `src/preload.test.ts`, `src/global.d.ts`, `src/main.ts`, `src/main.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6
- Produces: `type IpcOwner = { sender: WebContents; closed: boolean; detach: () => void }`, `createOwnerTracker(getWindow, onRelease, unauthorizedMessage): { authorize(event): IpcOwner; release(owner): void; dispose(): void; readonly disposed: boolean }`
- Produces: `ConversationRegistry.hasProject(projectPath: string): boolean`, `ConversationService.knowsProject(projectPath: string): Promise<boolean>`
- Produces: `registerFilesIpc(deps: FilesIpcDeps, getWindow): { dispose(): void }`, and `window.fractal.files: FilesApi` in the renderer

- [ ] **Step 1: Write the failing tests**

`src/main/ipc-owners.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { expect, test, vi } from 'vitest';
import { createOwnerTracker } from './ipc-owners';

class Sender extends EventEmitter {
  mainFrame = {};
  destroyed = false;
  isDestroyed() { return this.destroyed; }
}
function fixture() {
  const sender = new Sender();
  const onRelease = vi.fn();
  const tracker = createOwnerTracker(() => ({ webContents: sender, isDestroyed: () => false }) as unknown as BrowserWindow, onRelease, 'Unauthorized test sender');
  const event = (source: Sender = sender, frame: object = source.mainFrame) => ({ sender: source, senderFrame: frame }) as unknown as IpcMainInvokeEvent;
  return { sender, onRelease, tracker, event };
}

test('authorises only the window\'s main frame and returns one owner per sender', () => {
  const f = fixture();
  expect(f.tracker.authorize(f.event())).toBe(f.tracker.authorize(f.event()));
  expect(() => f.tracker.authorize(f.event(new Sender()))).toThrow('Unauthorized test sender');
  expect(() => f.tracker.authorize(f.event(f.sender, {}))).toThrow('Unauthorized test sender');
});

test('releases an owner once when it navigates away, and not for in-page or subframe navigation', () => {
  const f = fixture();
  const owner = f.tracker.authorize(f.event());
  f.sender.emit('did-start-navigation', {}, 'x', true, true);
  f.sender.emit('did-start-navigation', {}, 'x', false, false);
  expect(f.onRelease).not.toHaveBeenCalled();
  f.sender.emit('did-start-navigation', {}, 'x', false, true);
  f.sender.emit('destroyed');
  expect(f.onRelease).toHaveBeenCalledTimes(1);
  expect(f.onRelease).toHaveBeenCalledWith(owner);
  expect(owner.closed).toBe(true);
  expect(f.tracker.authorize(f.event())).not.toBe(owner);
});

test('dispose releases every owner and refuses later calls', () => {
  const f = fixture();
  f.tracker.authorize(f.event());
  f.tracker.dispose();
  f.tracker.dispose();
  expect(f.onRelease).toHaveBeenCalledTimes(1);
  expect(f.tracker.disposed).toBe(true);
  expect(() => f.tracker.authorize(f.event())).toThrow('Unauthorized test sender');
});
```

Add to `src/main/conversation-registry.test.ts`, inside the `describe('ConversationRegistry')` block:

```ts
  test('knows a project only once discovery has found a conversation in it', async () => {
    const registry = new ConversationRegistry([adapter('codex')], realpath);
    expect(registry.hasProject('/repo')).toBe(false);
    await registry.list();
    expect(registry.hasProject('/repo')).toBe(true);
    expect(registry.hasProject('/elsewhere')).toBe(false);
  });
```

Add to `src/main/conversation-service.test.ts`:

```ts
describe('ConversationService.knowsProject', () => {
  test('discovers again before saying a project is unknown', async () => {
    const f = fixture();
    expect(await f.service.knowsProject('/repo')).toBe(true);
    expect(await f.service.knowsProject('/elsewhere')).toBe(false);
    await f.service.dispose();
  });

  test('knows the project of an unsent Claude draft', async () => {
    const f = fixture([], 50, 'claude');
    const draft = { provider: 'claude' as const, nativeSessionId: '00000000-0000-4000-8000-000000000097', projectPath: '/new' };
    vi.mocked(f.adapter.listConversations).mockResolvedValue([]);
    vi.mocked(f.adapter.createConversation).mockResolvedValue(draft);
    await f.service.create('claude', '/new');
    expect(await f.service.knowsProject('/new')).toBe(true);
    await f.service.dispose();
  });
});
```

`src/main/files/files-ipc.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FILES_CHANNELS, type OpenResult } from '@/shared/files-contract';
import { FileWatchService } from './file-watch-service';
import { registerFilesIpc } from './files-ipc';

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>>() }));
vi.mock('electron', () => ({ ipcMain: {
  handle: (name: string, handler: (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>) => electron.handlers.set(name, handler),
  removeHandler: (name: string) => electron.handlers.delete(name),
} }));

class Sender extends EventEmitter {
  mainFrame = {};
  send = vi.fn();
  destroyed = false;
  isDestroyed() { return this.destroyed; }
}

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fractal-files-ipc-')));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'a');
});
afterEach(async () => {
  electron.handlers.clear();
  await rm(root, { recursive: true, force: true });
});

function fixture() {
  const sender = new Sender();
  const watched: Array<{ onChange: (name: string | null) => void; closed: boolean }> = [];
  const watches = new FileWatchService((_directory, onChange) => {
    const entry = { onChange, closed: false };
    watched.push(entry);
    return { close: () => { entry.closed = true; } };
  }, 0);
  const knowsProject = vi.fn(async (projectPath: string) => projectPath === root);
  const open = vi.fn(async (): Promise<OpenResult> => ({ ok: true }));
  const editors = vi.fn(async () => [{ id: 'zed' as const, label: 'Zed', executable: '/bin/zed' }]);
  const registration = registerFilesIpc({ knowsProject, watches, editors, open }, () => ({ webContents: sender, isDestroyed: () => sender.destroyed }) as unknown as BrowserWindow);
  const invoke = (request: unknown, source: Sender = sender, frame: object = source.mainFrame) => {
    const handler = electron.handlers.get(FILES_CHANNELS.invoke);
    if (!handler) throw new Error('Missing files handler');
    return handler({ sender: source, senderFrame: frame } as unknown as IpcMainInvokeEvent, request);
  };
  return { sender, watched, knowsProject, open, registration, invoke };
}

test('serves a known project, asking about each root once', async () => {
  const f = fixture();
  expect(await f.invoke({ method: 'readFile', root, path: 'src/a.ts' })).toEqual({ kind: 'text', content: 'a', size: 1 });
  expect(await f.invoke({ method: 'listDirectory', root, path: '' })).toMatchObject([{ name: 'src', kind: 'directory' }]);
  expect(await f.invoke({ method: 'listFiles', root })).toMatchObject({ paths: ['src/a.ts'], truncated: false });
  expect(f.knowsProject).toHaveBeenCalledTimes(1);
  f.registration.dispose();
});

test('refuses unknown projects, escaping paths, malformed requests, and foreign senders', async () => {
  const f = fixture();
  await expect(f.invoke({ method: 'listDirectory', root: '/', path: '' })).rejects.toThrow('Unknown project');
  await expect(f.invoke({ method: 'readFile', root, path: '../x' })).rejects.toThrow('Path is outside the project');
  await expect(f.invoke({ method: 'readFile', root, path: '/etc/passwd' })).rejects.toThrow('Invalid files request');
  await expect(f.invoke({ method: 'readFile', root, path: 'src/a.ts' }, new Sender())).rejects.toThrow('Unauthorized files sender');
  await expect(f.invoke({ method: 'readFile', root, path: 'src/a.ts' }, f.sender, {})).rejects.toThrow('Unauthorized files sender');
  f.registration.dispose();
});

test('sends change events to the owner and closes its watches when it navigates away', async () => {
  const f = fixture();
  await f.invoke({ method: 'watch', watchId: 'w1', root, path: 'src' });
  f.watched[0].onChange('a.ts');
  await vi.waitFor(() => expect(f.sender.send).toHaveBeenCalledWith(FILES_CHANNELS.event, { type: 'changed', watchId: 'w1' }));
  f.sender.emit('did-start-navigation', {}, 'x', false, true);
  expect(f.watched[0].closed).toBe(true);
  f.registration.dispose();
});

test('opens with the real root and the file inside it, and reports a vanished file', async () => {
  const f = fixture();
  expect(await f.invoke({ method: 'open', action: 'zed', root, path: 'src/a.ts', line: 3 })).toEqual({ ok: true });
  expect(f.open).toHaveBeenCalledWith('zed', { root, file: join(root, 'src', 'a.ts'), line: 3 });
  expect(await f.invoke({ method: 'open', action: 'zed', root, path: 'src/gone.ts' })).toEqual({ ok: false, message: 'This file no longer exists' });
  f.registration.dispose();
});

test('lists editors without their executables, and dispose removes the handler and every watch', async () => {
  const f = fixture();
  expect(await f.invoke({ method: 'editors' })).toEqual([{ id: 'zed', label: 'Zed' }]);
  await f.invoke({ method: 'watch', watchId: 'w1', root, path: '' });
  f.registration.dispose();
  f.registration.dispose();
  expect(f.watched[0].closed).toBe(true);
  expect(electron.handlers.has(FILES_CHANNELS.invoke)).toBe(false);
});
```

Add to `src/preload.test.ts`, after the terminal test:

```ts
test('files preload calls one invoke channel and filters its events', async () => {
  const { surface, events } = await preload();
  const files = (surface as unknown as { files: FilesApi }).files;
  await files.listDirectory('/repo', 'src');
  await files.open('zed', '/repo', 'a.ts');
  await files.open('zed', '/repo', 'a.ts', 4);
  expect(mocks.invoke.mock.calls).toEqual([
    ['fractal:files:invoke', { method: 'listDirectory', root: '/repo', path: 'src' }],
    ['fractal:files:invoke', { method: 'open', action: 'zed', root: '/repo', path: 'a.ts' }],
    ['fractal:files:invoke', { method: 'open', action: 'zed', root: '/repo', path: 'a.ts', line: 4 }],
  ]);
  const listener = vi.fn();
  const off = files.onEvent(listener);
  events.emit('fractal:files:event', { sender: 'native' }, { type: 'changed', watchId: 'w1', privateField: 'strip' });
  events.emit('fractal:files:event', { sender: 'native' }, { type: 'changed', watchId: 7 });
  expect(listener.mock.calls).toEqual([[{ type: 'changed', watchId: 'w1' }]]);
  off();
  expect(events.listenerCount('fractal:files:event')).toBe(0);
});
```

Add `import type { FilesApi } from '@/shared/files-contract';` at the top of `src/preload.test.ts`, and change its surface-keys expectation to `['attachments', 'conversations', 'files', 'models', 'settings', 'terminals']`.

In `src/main.test.ts`:
- Add to the hoisted `state`:

```ts
  registerFiles: vi.fn(() => ({ dispose: () => { state.events.push('files-ipc-dispose'); } })),
  disposeFileWatches: vi.fn(() => { state.events.push('file-watches-dispose'); }),
```

- Add `shell: {}` to the object returned by the `electron` mock.
- Add the mocks:

```ts
vi.mock('@/main/files/files-ipc', () => ({ registerFilesIpc: state.registerFiles }));
vi.mock('@/main/files/file-watch-service', () => ({ FileWatchService: class { dispose = state.disposeFileWatches; } }));
```

- In the test `'starts once after the window exists, waits before loading, and disposes before final quit'`, add `expect(state.registerFiles).toHaveBeenCalledTimes(1);` beside `expect(state.registerModel)...`, and `expect(state.events).toContain('files-ipc-dispose'); expect(state.disposeFileWatches).toHaveBeenCalledTimes(1);` beside the other dispose assertions.
- In `'shutdown during server startup disposes the eventual process without registering or loading a renderer'`, add `expect(state.registerFiles).not.toHaveBeenCalled();`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/main/ipc-owners.test.ts src/main/files/files-ipc.test.ts src/main/conversation-registry.test.ts src/main/conversation-service.test.ts src/preload.test.ts src/main.test.ts`
Expected: FAIL. The new modules are missing, `hasProject` and `knowsProject` are not functions, the preload exposes no `files`, and main never calls `registerFilesIpc`.

- [ ] **Step 3: Implement the owner tracker and move terminal IPC onto it**

`src/main/ipc-owners.ts` (the logic is the owner handling from `terminal-ipc.ts`, moved):

```ts
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';

export type IpcOwner = { sender: WebContents; closed: boolean; detach: () => void };

/**
 * Tracks the renderers that own main-process resources over one IPC surface.
 * An owner is released exactly once, when its WebContents is destroyed,
 * navigates its main frame to a new document, or crashes; `onRelease` then
 * frees what it owned. Only the app window's main frame is authorised.
 */
export function createOwnerTracker(getWindow: () => BrowserWindow | null, onRelease: (owner: IpcOwner) => void, unauthorizedMessage: string) {
  const owners = new Map<WebContents, IpcOwner>();
  let disposed = false;

  const release = (owner: IpcOwner) => {
    if (owner.closed) return;
    owner.closed = true;
    owner.detach();
    owners.delete(owner.sender);
    onRelease(owner);
  };

  const ownerFor = (sender: WebContents): IpcOwner => {
    const known = owners.get(sender);
    if (known) return known;
    const owner: IpcOwner = { sender, closed: false, detach: () => undefined };
    const destroyed = () => release(owner);
    const navigated = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) release(owner);
    };
    const crashed = () => release(owner);
    sender.on('destroyed', destroyed);
    sender.on('did-start-navigation', navigated);
    sender.on('render-process-gone', crashed);
    owner.detach = () => {
      sender.removeListener('destroyed', destroyed);
      sender.removeListener('did-start-navigation', navigated);
      sender.removeListener('render-process-gone', crashed);
    };
    owners.set(sender, owner);
    return owner;
  };

  return {
    authorize(event: IpcMainInvokeEvent): IpcOwner {
      const window = getWindow();
      if (disposed || !window || window.isDestroyed() || event.sender !== window.webContents || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
        throw new Error(unauthorizedMessage);
      }
      return ownerFor(event.sender);
    },
    release,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const owner of [...owners.values()]) release(owner);
    },
    get disposed() { return disposed; },
  };
}
```

Replace `src/main/terminal-ipc.ts` with:

```ts
import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createOwnerTracker } from '@/main/ipc-owners';
import { TERMINAL_CHANNELS, parseTerminalRequest } from '@/shared/terminal-contract';
import type { TerminalService } from './terminal-service';

export function registerTerminalIpc(service: TerminalService, getWindow: () => BrowserWindow | null): { dispose(): void } {
  const owners = createOwnerTracker(getWindow, (owner) => service.closeOwner(owner), 'Unauthorized terminal sender');

  ipcMain.handle(TERMINAL_CHANNELS.invoke, async (event, input: unknown) => {
    const owner = owners.authorize(event);
    const request = parseTerminalRequest(input);
    if (request.method === 'create') {
      const inputCwd = request.cwd ?? process.cwd();
      let cwd: string;
      try {
        if (!isAbsolute(inputCwd) || !(await stat(inputCwd)).isDirectory()) throw new Error('Not a directory');
        cwd = await realpath(inputCwd);
      } catch { throw new Error('Terminal could not start in this folder'); }
      if (owners.disposed || owner.closed) throw new Error('Terminal operation failed');
      try {
        return service.create(owner, request, cwd, (payload) => {
          if (owner.closed || owner.sender.isDestroyed()) return;
          try { owner.sender.send(TERMINAL_CHANNELS.event, payload); } catch { owners.release(owner); }
        });
      } catch { throw new Error('Terminal could not start'); }
    }
    if (owner.closed) throw new Error('Terminal operation failed');
    try {
      if (request.method === 'write') service.write(owner, request.id, request.data);
      else if (request.method === 'resize') service.resize(owner, request.id, request.cols, request.rows);
      else service.close(owner, request.id);
    } catch { throw new Error('Terminal operation failed'); }
  });

  return {
    dispose() {
      if (owners.disposed) return;
      ipcMain.removeHandler(TERMINAL_CHANNELS.invoke);
      owners.dispose();
    },
  };
}
```

- [ ] **Step 4: Add the known-project check**

In `src/main/conversation-registry.ts`, add after `list()`:

```ts
  /** Whether discovery has found a conversation in this canonical project path, as of its last run. */
  hasProject(projectPath: string): boolean {
    for (const summaries of this.summaries.values()) {
      if (summaries.some((summary) => summary.ref.projectPath === projectPath)) return true;
    }
    return false;
  }
```

In `src/main/conversation-service.ts`, add after `list()`:

```ts
  /** Whether a conversation main knows of is in this project: a discovered one, or a Claude draft not yet sent. */
  async knowsProject(projectPath: string): Promise<boolean> {
    this.assertAvailable();
    const known = () => this.registry.hasProject(projectPath) ||
      [...this.drafts.values()].some((draft) => draft.ref.projectPath === projectPath);
    if (known()) return true;
    // A conversation may have started since the last discovery; look once more.
    await this.registry.list();
    return known();
  }
```

- [ ] **Step 5: Implement the files IPC handler**

`src/main/files/files-ipc.ts`:

```ts
import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { createOwnerTracker, type IpcOwner } from '@/main/ipc-owners';
import { FILES_CHANNELS, parseFilesRequest, type FilesEvent, type FilesRequest, type OpenAction, type OpenResult } from '@/shared/files-contract';
import type { DetectedEditor } from './editors';
import { listDirectory, listProjectFiles, readProjectFile } from './file-service';
import type { FileWatchService } from './file-watch-service';
import { isMissing, OutsideProjectError, resolveInProject } from './project-paths';

export interface FilesIpcDeps {
  /** Whether a conversation main knows of is in this project. Only such projects are served. */
  knowsProject(projectPath: string): Promise<boolean>;
  watches: FileWatchService;
  editors(): Promise<DetectedEditor[]>;
  open(action: OpenAction, target: { root: string; file: string; line?: number }): Promise<OpenResult>;
}

class UnknownProjectError extends Error {
  override name = 'UnknownProjectError';
}

export function registerFilesIpc(deps: FilesIpcDeps, getWindow: () => BrowserWindow | null): { dispose(): void } {
  const owners = createOwnerTracker(getWindow, (owner) => deps.watches.closeOwner(owner), 'Unauthorized files sender');
  const knownRoots = new Set<string>();

  const checkRoot = async (root: string) => {
    if (knownRoots.has(root)) return;
    if (!(await deps.knowsProject(root))) throw new UnknownProjectError('Unknown project');
    knownRoots.add(root);
  };

  const sendTo = (owner: IpcOwner) => (event: FilesEvent) => {
    if (owner.closed || owner.sender.isDestroyed()) return;
    try { owner.sender.send(FILES_CHANNELS.event, event); } catch { owners.release(owner); }
  };

  const handle = async (owner: IpcOwner, request: FilesRequest): Promise<unknown> => {
    if (request.method === 'editors') return (await deps.editors()).map(({ id, label }) => ({ id, label }));
    if (request.method === 'unwatch') { deps.watches.unwatch(owner, request.watchId); return undefined; }
    await checkRoot(request.root);
    if (request.method === 'listDirectory') return listDirectory(request.root, request.path);
    if (request.method === 'readFile') return readProjectFile(request.root, request.path);
    if (request.method === 'listFiles') return listProjectFiles(request.root);
    if (request.method === 'watch') {
      await deps.watches.watch(owner, request.watchId, request.root, request.path, sendTo(owner));
      return undefined;
    }
    let target;
    try {
      target = await resolveInProject(request.root, request.path);
    } catch (error) {
      if (isMissing(error)) return { ok: false, message: 'This file no longer exists' } satisfies OpenResult;
      throw error;
    }
    return deps.open(request.action, { root: target.realRoot, file: target.lexical, ...(request.line === undefined ? {} : { line: request.line }) });
  };

  ipcMain.handle(FILES_CHANNELS.invoke, async (event, input: unknown) => {
    const owner = owners.authorize(event);
    const request = parseFilesRequest(input);
    try {
      return await handle(owner, request);
    } catch (error) {
      // Only reasons written here cross to the renderer; filesystem details stay in main.
      if (error instanceof OutsideProjectError) throw new Error('Path is outside the project');
      if (error instanceof UnknownProjectError) throw new Error('Unknown project');
      throw new Error('File operation failed');
    }
  });

  return {
    dispose() {
      if (owners.disposed) return;
      ipcMain.removeHandler(FILES_CHANNELS.invoke);
      owners.dispose();
    },
  };
}
```

- [ ] **Step 6: Expose the API in preload and register it in main**

In `src/preload.ts`, add the import and the API, and add `files` to `exposeInMainWorld`:

```ts
import { FILES_CHANNELS, parseFilesEvent, type FilesApi } from '@/shared/files-contract';
```

```ts
const invokeFiles = (request: Record<string, unknown>) => ipcRenderer.invoke(FILES_CHANNELS.invoke, request);

const files: FilesApi = {
  listDirectory: (root, path) => invokeFiles({ method: 'listDirectory', root, path }),
  readFile: (root, path) => invokeFiles({ method: 'readFile', root, path }),
  listFiles: (root) => invokeFiles({ method: 'listFiles', root }),
  watch: (watchId, root, path) => invokeFiles({ method: 'watch', watchId, root, path }),
  unwatch: (watchId) => invokeFiles({ method: 'unwatch', watchId }),
  editors: () => invokeFiles({ method: 'editors' }),
  open: (action, root, path, line) => invokeFiles({ method: 'open', action, root, path, ...(line === undefined ? {} : { line }) }),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      try { listener(parseFilesEvent(payload)); } catch { /* Drop invalid native events. */ }
    };
    ipcRenderer.on(FILES_CHANNELS.event, handler);
    return () => { ipcRenderer.removeListener(FILES_CHANNELS.event, handler); };
  },
};

contextBridge.exposeInMainWorld('fractal', { conversations, models, settings, terminals, attachments, files });
```

In `src/global.d.ts`, add `import type { FilesApi } from '@/shared/files-contract';` and `files: FilesApi;` to `window.fractal`.

In `src/main.ts`:
- Change the electron import to `import { app, BrowserWindow, Menu, shell } from 'electron';`.
- Add the imports:

```ts
import { detectEditors, openWith, type DetectedEditor } from '@/main/files/editors';
import { FileWatchService } from '@/main/files/file-watch-service';
import { registerFilesIpc } from '@/main/files/files-ipc';
```

- Next to `let modelRegistration`, add:

```ts
let fileWatches: FileWatchService | undefined;
let filesRegistration: { dispose(): void } | undefined;
```

- In the `conversationStartup` block, immediately after the line that assigns `const registration = registerConversationIpc(...)` and before `loadWindow(window);`, add:

```ts
    // Editors are found on first use, by which point the login shell's PATH has been merged above.
    let editors: Promise<DetectedEditor[]> | undefined;
    const detectedEditors = () => (editors ??= detectEditors(process.platform, process.env.PATH ?? ''));
    fileWatches = new FileWatchService();
    filesRegistration = registerFilesIpc({
      knowsProject: (projectPath) => conversationService?.knowsProject(projectPath) ?? Promise.resolve(false),
      watches: fileWatches,
      editors: detectedEditors,
      open: (action, target) => openWith(action, target, { editors: detectedEditors, shell }),
    }, () => mainWindowRef);
```

- In the `before-quit` handler, after `terminalService?.dispose();`, add:

```ts
    filesRegistration?.dispose();
    fileWatches?.dispose();
```

- [ ] **Step 7: Run the full suite, lint, and typecheck**

Run: `pnpm test && pnpm lint && pnpm exec tsc --noEmit`
Expected: PASS, including the unchanged `terminal-ipc.test.ts`, which proves the owner extraction kept terminal behaviour.

- [ ] **Step 8: Commit**

```bash
git add src/main/ipc-owners.ts src/main/ipc-owners.test.ts src/main/terminal-ipc.ts src/main/conversation-registry.ts src/main/conversation-registry.test.ts src/main/conversation-service.ts src/main/conversation-service.test.ts src/main/files/files-ipc.ts src/main/files/files-ipc.test.ts src/preload.ts src/preload.test.ts src/global.d.ts src/main.ts src/main.test.ts
git commit -m "feat(files): serve files over IPC to known projects only

- extract owner tracking and sender checks from terminal IPC into ipc-owners for reuse
- add knowsProject so the files handler serves only projects with a known conversation
- add the files IPC handler, which reports only reasons written in main
- expose window.fractal.files from preload and register the handler at startup"
```

---

### Task 8: Panel tab model

The pure state for terminal and file tabs, including the preview rules. It isn't used by any component yet.

**Files:**
- Create: `src/renderer/panel-tabs.ts`, `src/renderer/panel-tabs.test.ts`

**Interfaces:**
- Consumes: `TerminalTab`, `nextTerminalNumber` from `src/components/right-panel/terminal-tabs.tsx`
- Produces: `type TerminalPanelTab = TerminalTab & { kind: 'terminal' }`, `type FilePanelTab = { kind: 'file'; id: string; projectPath: string; path: string | null; preview: boolean }`, `type PanelTab`, `interface PanelTabsState { tabs: PanelTab[]; selectedId: string | null; recent: string[] }`, `emptyPanelTabs`, `selectTab(state, id)`, `addTerminalTab(state, id, cwd)`, `updateTerminalTab(state, id, patch)`, `closeTab(state, id)`, `activeTerminalId(state): string | undefined`, `openFilesTool(state, projectPath, newId)`, `openFile(state, projectPath, path, pinned, newId)`, `pinTab(state, id)`. Every function returns a new `PanelTabsState`, except `activeTerminalId`.

- [ ] **Step 1: Write the failing test**

`src/renderer/panel-tabs.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { activeTerminalId, addTerminalTab, closeTab, emptyPanelTabs, openFile, openFilesTool, pinTab, selectTab, updateTerminalTab, type FilePanelTab, type PanelTabsState } from './panel-tabs';

const fileTabs = (state: PanelTabsState) => state.tabs.filter((tab): tab is FilePanelTab => tab.kind === 'file');
const selected = (state: PanelTabsState) => state.tabs.find((tab) => tab.id === state.selectedId);

describe('terminal tabs', () => {
  test('numbers and selects new terminals, and selects a neighbour when the selected one closes', () => {
    let state = addTerminalTab(emptyPanelTabs, 't1', '/repo');
    state = addTerminalTab(state, 't2', '/repo');
    expect(state.tabs).toMatchObject([{ kind: 'terminal', id: 't1', number: 1 }, { kind: 'terminal', id: 't2', number: 2 }]);
    expect(state.selectedId).toBe('t2');
    state = updateTerminalTab(state, 't1', { shell: 'zsh', exited: true });
    expect(state.tabs[0]).toMatchObject({ shell: 'zsh', exited: true });
    state = closeTab(state, 't2');
    expect(state.selectedId).toBe('t1');
    expect(closeTab(state, 't1')).toMatchObject({ tabs: [], selectedId: null });
  });

  test('Ctrl+` acts on the selected terminal, or else the one used most recently', () => {
    let state = addTerminalTab(emptyPanelTabs, 't1', '/repo');
    state = addTerminalTab(state, 't2', '/repo');
    state = selectTab(state, 't1');
    expect(activeTerminalId(state)).toBe('t1');
    state = openFilesTool(state, '/repo', 'f1');
    expect(activeTerminalId(state)).toBe('t1');
    expect(activeTerminalId(emptyPanelTabs)).toBeUndefined();
  });
});

describe('file tabs', () => {
  test('Files opens an empty preview tab, then reselects the project\'s most recent file tab', () => {
    let state = openFilesTool(emptyPanelTabs, '/repo', 'f1');
    expect(selected(state)).toEqual({ kind: 'file', id: 'f1', projectPath: '/repo', path: null, preview: true });
    state = openFile(state, '/repo', 'a.ts', true, 'f2');
    state = openFile(state, '/repo', 'b.ts', true, 'f3');
    state = selectTab(state, 'f2');
    state = addTerminalTab(state, 't1', '/repo');
    state = openFilesTool(state, '/repo', 'unused');
    expect(state.selectedId).toBe('f2');
    expect(fileTabs(state)).toHaveLength(2);
    state = openFilesTool(state, '/other', 'f4');
    expect(selected(state)).toMatchObject({ projectPath: '/other', path: null });
  });

  test('a click fills the empty Files tab, then replaces the preview tab\'s file', () => {
    let state = openFilesTool(emptyPanelTabs, '/repo', 'f1');
    state = openFile(state, '/repo', 'a.ts', false, 'unused');
    expect(fileTabs(state)).toEqual([{ kind: 'file', id: 'f1', projectPath: '/repo', path: 'a.ts', preview: true }]);
    state = openFile(state, '/repo', 'b.ts', false, 'unused');
    expect(fileTabs(state)).toEqual([{ kind: 'file', id: 'f1', projectPath: '/repo', path: 'b.ts', preview: true }]);
  });

  test('an open file is selected rather than opened again, and pinning keeps it', () => {
    let state = openFile(emptyPanelTabs, '/repo', 'a.ts', true, 'f1');
    state = openFile(state, '/repo', 'b.ts', false, 'f2');
    state = openFile(state, '/repo', 'a.ts', false, 'unused');
    expect(state.selectedId).toBe('f1');
    state = openFile(state, '/repo', 'b.ts', true, 'unused');
    expect(fileTabs(state)).toMatchObject([{ id: 'f1', preview: false }, { id: 'f2', path: 'b.ts', preview: false }]);
  });

  test('a pinned open leaves the preview tab alone, but fills an empty Files tab', () => {
    let state = openFile(emptyPanelTabs, '/repo', 'a.ts', false, 'f1');
    state = openFile(state, '/repo', 'b.ts', true, 'f2');
    expect(fileTabs(state)).toMatchObject([{ id: 'f1', path: 'a.ts', preview: true }, { id: 'f2', path: 'b.ts', preview: false }]);
    let empty = openFilesTool(emptyPanelTabs, '/repo', 'e1');
    empty = openFile(empty, '/repo', 'c.ts', true, 'unused');
    expect(fileTabs(empty)).toEqual([{ kind: 'file', id: 'e1', projectPath: '/repo', path: 'c.ts', preview: false }]);
  });

  test('pinning a preview tab means the next click opens a new preview', () => {
    let state = openFile(emptyPanelTabs, '/repo', 'a.ts', false, 'f1');
    state = pinTab(state, 'f1');
    state = openFile(state, '/repo', 'b.ts', false, 'f2');
    expect(fileTabs(state)).toMatchObject([{ id: 'f1', path: 'a.ts', preview: false }, { id: 'f2', path: 'b.ts', preview: true }]);
  });

  test('an empty Files tab cannot be made permanent', () => {
    const state = pinTab(openFilesTool(emptyPanelTabs, '/repo', 'f1'), 'f1');
    expect(fileTabs(state)[0].preview).toBe(true);
  });

  test('each project has its own preview tab', () => {
    let state = openFile(emptyPanelTabs, '/a', 'x.ts', false, 'f1');
    state = openFile(state, '/b', 'y.ts', false, 'f2');
    expect(fileTabs(state)).toMatchObject([{ projectPath: '/a', path: 'x.ts', preview: true }, { projectPath: '/b', path: 'y.ts', preview: true }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/renderer/panel-tabs.test.ts`
Expected: FAIL, because `./panel-tabs` cannot be found.

- [ ] **Step 3: Implement the model**

`src/renderer/panel-tabs.ts`:

```ts
import { nextTerminalNumber, type TerminalTab } from '@/components/right-panel/terminal-tabs';

export type TerminalPanelTab = TerminalTab & { kind: 'terminal' };

export type FilePanelTab = {
  kind: 'file';
  id: string;
  /** Fixed when the tab is created, like a terminal's directory. */
  projectPath: string;
  /** Relative to the project and '/'-separated; null until a file is chosen. */
  path: string | null;
  /** Shows whichever file was clicked last in its project. At most one per project. */
  preview: boolean;
};

export type PanelTab = TerminalPanelTab | FilePanelTab;

export interface PanelTabsState {
  tabs: PanelTab[];
  selectedId: string | null;
  /** Tab ids, most recently selected first. */
  recent: string[];
}

export const emptyPanelTabs: PanelTabsState = { tabs: [], selectedId: null, recent: [] };

const touch = (recent: string[], id: string) => [id, ...recent.filter((other) => other !== id)];
const append = (state: PanelTabsState, tab: PanelTab): PanelTabsState =>
  ({ tabs: [...state.tabs, tab], selectedId: tab.id, recent: touch(state.recent, tab.id) });
const projectFileTabs = (state: PanelTabsState, projectPath: string) =>
  state.tabs.filter((tab): tab is FilePanelTab => tab.kind === 'file' && tab.projectPath === projectPath);

export function selectTab(state: PanelTabsState, id: string): PanelTabsState {
  return state.tabs.some((tab) => tab.id === id) ? { ...state, selectedId: id, recent: touch(state.recent, id) } : state;
}

export function addTerminalTab(state: PanelTabsState, id: string, cwd: string | null): PanelTabsState {
  const terminals = state.tabs.filter((tab): tab is TerminalPanelTab => tab.kind === 'terminal');
  return append(state, { kind: 'terminal', id, cwd, number: nextTerminalNumber(terminals) });
}

export function updateTerminalTab(state: PanelTabsState, id: string, patch: Partial<Omit<TerminalTab, 'id'>>): PanelTabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.kind === 'terminal' && tab.id === id ? { ...tab, ...patch } : tab)) };
}

/** Closes a tab; closing the selected one selects its neighbour, as the terminal tabs always have. */
export function closeTab(state: PanelTabsState, id: string): PanelTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const recent = state.recent.filter((other) => other !== id);
  if (state.selectedId !== id) return { ...state, tabs, recent };
  const selectedId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
  return { tabs, selectedId, recent: selectedId ? touch(recent, selectedId) : recent };
}

/** The terminal Ctrl+` acts on: the selected tab if it is a terminal, otherwise the terminal used most recently. */
export function activeTerminalId(state: PanelTabsState): string | undefined {
  const terminals = new Set(state.tabs.filter((tab) => tab.kind === 'terminal').map((tab) => tab.id));
  if (state.selectedId !== null && terminals.has(state.selectedId)) return state.selectedId;
  return state.recent.find((id) => terminals.has(id));
}

/** Files from the tool list: the project's most recently used file tab, or a new tab with no file yet. */
export function openFilesTool(state: PanelTabsState, projectPath: string, newId: string): PanelTabsState {
  const ids = new Set(projectFileTabs(state, projectPath).map((tab) => tab.id));
  const recentId = state.recent.find((id) => ids.has(id));
  if (recentId) return selectTab(state, recentId);
  return append(state, { kind: 'file', id: newId, projectPath, path: null, preview: true });
}

/**
 * Opens a file by VS Code's preview rules. A file that is already open has
 * its tab selected. Otherwise the project's preview tab shows it, or a new
 * preview tab opens. `pinned` opens it in a permanent tab instead, except
 * that a tab with no file yet is filled rather than left empty beside it.
 */
export function openFile(state: PanelTabsState, projectPath: string, path: string, pinned: boolean, newId: string): PanelTabsState {
  const tabs = projectFileTabs(state, projectPath);
  const existing = tabs.find((tab) => tab.path === path);
  if (existing) return selectTab(pinned ? pinTab(state, existing.id) : state, existing.id);
  const reusable = tabs.find((tab) => tab.preview && (!pinned || tab.path === null));
  if (reusable) {
    const filled = { ...state, tabs: state.tabs.map((tab) => (tab.id === reusable.id ? { ...reusable, path, preview: !pinned } : tab)) };
    return selectTab(filled, reusable.id);
  }
  return append(state, { kind: 'file', id: newId, projectPath, path, preview: !pinned });
}

/** Makes a file tab permanent. A tab with no file stays a preview, so the next file still fills it. */
export function pinTab(state: PanelTabsState, id: string): PanelTabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.kind === 'file' && tab.id === id && tab.path !== null ? { ...tab, preview: false } : tab)) };
}
```

- [ ] **Step 4: Run the test, lint, and typecheck**

Run: `pnpm vitest run src/renderer/panel-tabs.test.ts && pnpm lint && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/panel-tabs.ts src/renderer/panel-tabs.test.ts
git commit -m "feat(files): model terminal and file tabs with preview rules"
```

---

### Task 9: Panel tab row

A tab row that renders both tab kinds. It replaces `TerminalTabs`, which stays in place until Task 12 rewires the panel.

**Files:**
- Create: `src/components/right-panel/panel-tabs.tsx`, `src/components/right-panel/panel-tabs.test.tsx`

**Interfaces:**
- Consumes: `PanelTab` (Task 8); `terminalTabLabel` from `terminal-tabs.tsx`; `basename` (Task 1)
- Produces: `panelTabLabel(tab: PanelTab, terminalCount: number): string`, `tabPanelId(tab: PanelTab): string`, `PanelTabs({ tabs, selectedId, onSelect, onClose, onPin })`

- [ ] **Step 1: Write the failing test**

`src/components/right-panel/panel-tabs.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { PanelTab } from '@/renderer/panel-tabs';
import { PanelTabs, panelTabLabel, tabPanelId } from './panel-tabs';

afterEach(cleanup);

const tabs: PanelTab[] = [
  { kind: 'terminal', id: 'a', cwd: '/repo', number: 1, shell: 'zsh' },
  { kind: 'terminal', id: 'b', cwd: '/repo', number: 2, shell: 'zsh', exited: true },
  { kind: 'file', id: 'f', projectPath: '/repo', path: 'src/a.ts', preview: true },
  { kind: 'file', id: 'g', projectPath: '/repo', path: null, preview: true },
  { kind: 'file', id: 'h', projectPath: '/repo', path: 'README.md', preview: false },
];

test('labels terminals and file tabs, and names each tab\'s panel', () => {
  expect(panelTabLabel(tabs[0], 2)).toBe('Terminal 1');
  expect(panelTabLabel(tabs[2], 2)).toBe('a.ts');
  expect(panelTabLabel(tabs[3], 2)).toBe('Files');
  expect(tabPanelId(tabs[0])).toBe('terminal-panel-a');
  expect(tabPanelId(tabs[2])).toBe('panel-f');
});

test('selects, closes, pins file tabs on double-click, and marks previews and exited shells', async () => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const onPin = vi.fn();
  render(<TooltipProvider><PanelTabs onClose={onClose} onPin={onPin} onSelect={onSelect} selectedId="f" tabs={tabs} /></TooltipProvider>);
  const user = userEvent.setup();
  const preview = screen.getByRole('tab', { name: 'a.ts (preview)' });
  expect(preview.getAttribute('aria-selected')).toBe('true');
  expect(preview.querySelector('.italic')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'README.md' }).querySelector('.italic')).toBeNull();
  expect(screen.getByRole('tab', { name: 'Terminal 2 (exited)' })).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: 'Terminal 1' }));
  expect(onSelect).toHaveBeenCalledWith('a');
  await user.dblClick(preview);
  expect(onPin).toHaveBeenCalledWith('f');
  await user.dblClick(screen.getByRole('tab', { name: 'Terminal 1' }));
  expect(onPin).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Close a.ts' }));
  expect(onClose).toHaveBeenCalledWith('f');
  fireEvent(screen.getByRole('tab', { name: 'README.md' }), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(onClose).toHaveBeenCalledWith('h');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/components/right-panel/panel-tabs.test.tsx`
Expected: FAIL, because `./panel-tabs` cannot be found.

- [ ] **Step 3: Implement the tab row**

`src/components/right-panel/panel-tabs.tsx` (the markup and classes are `TerminalTabs`'s, extended to file tabs):

```tsx
import { FileText, SquareTerminal, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { absoluteProjectPath, basename } from '@/renderer/file-display';
import type { PanelTab } from '@/renderer/panel-tabs';
import { terminalTabLabel } from './terminal-tabs';

export function panelTabLabel(tab: PanelTab, terminalCount: number): string {
  if (tab.kind === 'terminal') return terminalTabLabel(tab, terminalCount);
  return tab.path === null ? 'Files' : basename(tab.path);
}

export const tabPanelId = (tab: PanelTab): string => (tab.kind === 'terminal' ? `terminal-panel-${tab.id}` : `panel-${tab.id}`);

function tooltipFor(tab: PanelTab): string {
  if (tab.kind === 'terminal') return tab.startedIn ?? tab.cwd ?? 'App working directory';
  return tab.path === null ? tab.projectPath : absoluteProjectPath(tab.projectPath, tab.path);
}

export function PanelTabs({ tabs, selectedId, onSelect, onClose, onPin }: {
  tabs: PanelTab[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
}) {
  const terminalCount = tabs.filter((tab) => tab.kind === 'terminal').length;
  return (
    <div aria-label="Right workspace tabs" className="flex min-w-0 items-center gap-1 overflow-x-auto" role="tablist">
      {tabs.map((tab) => {
        const label = panelTabLabel(tab, terminalCount);
        const selected = selectedId === tab.id;
        const preview = tab.kind === 'file' && tab.preview;
        const Icon = tab.kind === 'terminal' ? SquareTerminal : FileText;
        return (
          <div
            className="group flex h-8 shrink-0 items-center rounded-md border border-transparent text-xs text-muted-foreground hover:text-foreground data-[selected=true]:border-sidebar-border data-[selected=true]:bg-background data-[selected=true]:text-foreground"
            data-selected={selected}
            key={tab.id}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              onClose(tab.id);
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-controls={tabPanelId(tab)}
                  aria-selected={selected}
                  className="flex h-full max-w-40 items-center gap-1.5 rounded-md pr-1 pl-2 focus-visible:outline-2 focus-visible:outline-ring"
                  id={tab.id}
                  onClick={() => onSelect(tab.id)}
                  onDoubleClick={tab.kind === 'file' ? () => onPin(tab.id) : undefined}
                  role="tab"
                  type="button"
                >
                  <Icon aria-hidden className="size-3.5 shrink-0" />
                  <span className={cn('truncate', preview && 'italic')}>{label}</span>
                  {preview && <span className="sr-only"> (preview)</span>}
                  {tab.kind === 'terminal' && tab.exited && (
                    <>
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/70" />
                      <span className="sr-only"> (exited)</span>
                    </>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{tooltipFor(tab)}</TooltipContent>
            </Tooltip>
            <button
              aria-label={`Close ${label}`}
              className="mr-1 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100 group-data-[selected=true]:opacity-100"
              onClick={() => onClose(tab.id)}
              type="button"
            >
              <X aria-hidden className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run the test, lint, and typecheck**

Run: `pnpm vitest run src/components/right-panel && pnpm lint && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/right-panel/panel-tabs.tsx src/components/right-panel/panel-tabs.test.tsx
git commit -m "feat(files): render terminal and file tabs in one tab row"
```

---

### Task 10: File tree with filter

**Files:**
- Create: `src/renderer/file-filter.ts`, `src/renderer/file-filter.test.ts`
- Create: `src/renderer/use-watched-load.ts`
- Create: `src/components/right-panel/files/file-tree.tsx`, `src/components/right-panel/files/file-tree.test.tsx`

**Interfaces:**
- Consumes: `window.fractal.files` (Task 7); `FileEntry`, `FileList`, `FILE_LIST_MAX_ENTRIES` (Task 2); `absoluteProjectPath` (Task 1)
- Produces: `filterPaths(paths: readonly string[], query: string, limit: number): string[]`, `FILTER_RESULT_LIMIT`
- Produces: `type Watched<T>`, `useWatchedLoad<T>(root: string, path: string, load: (root: string, path: string) => Promise<T>): Watched<T>`. `load` must be a stable, module-level function.
- Produces: `type OpenFile = (path: string, options: { pinned: boolean }) => void`, `FileTree({ root, selectedPath, onOpen })`

- [ ] **Step 1: Write the failing tests**

`src/renderer/file-filter.test.ts`:

```ts
import { expect, test } from 'vitest';
import { filterPaths } from './file-filter';

const paths = ['src/readme/index.ts', 'README.md', 'docs/guide/readme-notes.md', 'src/app.ts'];

test('matches paths ignoring case, file-name matches first, then shorter paths', () => {
  expect(filterPaths(paths, 'readme', 10)).toEqual(['README.md', 'docs/guide/readme-notes.md', 'src/readme/index.ts']);
});

test('returns nothing for a blank query and stops at the limit', () => {
  expect(filterPaths(paths, '   ', 10)).toEqual([]);
  expect(filterPaths(paths, 's', 2)).toHaveLength(2);
});
```

`src/components/right-panel/files/file-tree.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';
import type { FileEntry, FilesEvent } from '@/shared/files-contract';
import { FileTree } from './file-tree';

const entry = (name: string, kind: FileEntry['kind'] = 'file', extra: Partial<FileEntry> = {}): FileEntry =>
  ({ name, kind, symlink: false, ignored: false, outside: false, ...extra });
const listeners = new Set<(event: FilesEvent) => void>();
let files: { listDirectory: Mock; listFiles: Mock; watch: Mock; unwatch: Mock; onEvent: Mock };

beforeEach(() => {
  listeners.clear();
  const directories: Record<string, FileEntry[]> = {
    '': [entry('out', 'directory', { ignored: true }), entry('src', 'directory'), entry('leak', 'file', { symlink: true, outside: true }), entry('README.md')],
    src: [entry('a.ts')],
  };
  files = {
    listDirectory: vi.fn(async (_root: string, path: string) => directories[path] ?? []),
    listFiles: vi.fn(async () => ({ paths: ['README.md', 'src/a.ts', 'src/abc/readme.ts'], truncated: true })),
    watch: vi.fn(async () => undefined),
    unwatch: vi.fn(async () => undefined),
    onEvent: vi.fn((listener: (event: FilesEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
  };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { files } });
});
afterEach(cleanup);

const emitChange = (watchId: string) => act(() => { for (const listener of listeners) listener({ type: 'changed', watchId }); });
const watchIdFor = (path: string) => files.watch.mock.calls.find((call) => call[2] === path)?.[0] as string;

test('lists the root, dims ignored entries, and disables links that leave the project', async () => {
  render(<FileTree onOpen={vi.fn()} root="/repo" selectedPath={null} />);
  expect(await screen.findByRole('button', { name: 'README.md' })).toBeTruthy();
  expect(files.listDirectory).toHaveBeenCalledWith('/repo', '');
  expect(files.listDirectory).not.toHaveBeenCalledWith('/repo', 'src');
  expect(screen.getByRole('button', { name: 'out' }).className).toContain('text-muted-foreground');
  expect(screen.getByRole('button', { name: 'leak' }).hasAttribute('disabled')).toBe(true);
});

test('expands and collapses folders, watching only what is expanded', async () => {
  const user = userEvent.setup();
  render(<FileTree onOpen={vi.fn()} root="/repo" selectedPath={null} />);
  await user.click(await screen.findByRole('button', { name: 'src' }));
  expect(await screen.findByRole('button', { name: 'a.ts' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'src' }).getAttribute('aria-expanded')).toBe('true');
  const srcWatch = watchIdFor('src');
  expect(srcWatch).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'src' }));
  expect(screen.queryByRole('button', { name: 'a.ts' })).toBeNull();
  expect(files.unwatch).toHaveBeenCalledWith(srcWatch);
});

test('reloads a folder when main reports it changed', async () => {
  render(<FileTree onOpen={vi.fn()} root="/repo" selectedPath={null} />);
  await screen.findByRole('button', { name: 'README.md' });
  files.listDirectory.mockResolvedValueOnce([entry('NEW.md')]);
  emitChange(watchIdFor(''));
  expect(await screen.findByRole('button', { name: 'NEW.md' })).toBeTruthy();
});

test('opens a file as a preview on click and in a new tab on double- or middle-click', async () => {
  const onOpen = vi.fn();
  const user = userEvent.setup();
  render(<FileTree onOpen={onOpen} root="/repo" selectedPath="README.md" />);
  const readme = await screen.findByRole('button', { name: 'README.md' });
  expect(readme.getAttribute('aria-current')).toBe('true');
  await user.click(readme);
  expect(onOpen).toHaveBeenLastCalledWith('README.md', { pinned: false });
  await user.dblClick(readme);
  expect(onOpen).toHaveBeenLastCalledWith('README.md', { pinned: true });
  onOpen.mockClear();
  fireEvent(readme, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(onOpen).toHaveBeenCalledWith('README.md', { pinned: true });
});

test('filters the whole project, fetching the list again each time the filter opens', async () => {
  const onOpen = vi.fn();
  const user = userEvent.setup();
  render(<FileTree onOpen={onOpen} root="/repo" selectedPath={null} />);
  const filter = await screen.findByRole('textbox', { name: 'Filter files' });
  await user.type(filter, 'readme');
  expect(await screen.findByRole('button', { name: 'src/abc/readme.ts' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'README.md' })).toBeTruthy();
  expect(screen.getByText('Searched the first 50,000 files.')).toBeTruthy();
  expect(files.listFiles).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'src/abc/readme.ts' }));
  expect(onOpen).toHaveBeenCalledWith('src/abc/readme.ts', { pinned: false });
  await user.clear(filter);
  await user.type(filter, 'a');
  await waitFor(() => expect(files.listFiles).toHaveBeenCalledTimes(2));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/renderer/file-filter.test.ts src/components/right-panel/files/file-tree.test.tsx`
Expected: FAIL, because the modules cannot be found.

- [ ] **Step 3: Implement the filter, the hook, and the tree**

`src/renderer/file-filter.ts`:

```ts
/** How many matches the filter shows; rendering more would cost more than it helps. */
export const FILTER_RESULT_LIMIT = 200;

/** Paths containing `query`, ignoring case: those whose file name contains it first, then shorter paths. */
export function filterPaths(paths: readonly string[], query: string, limit: number): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: Array<{ path: string; rank: number }> = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    if (!lower.includes(needle)) continue;
    matches.push({ path, rank: lower.slice(lower.lastIndexOf('/') + 1).includes(needle) ? 0 : 1 });
  }
  matches.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return matches.slice(0, limit).map((match) => match.path);
}
```

`src/renderer/use-watched-load.ts`:

```ts
import { useEffect, useState } from 'react';

export type Watched<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'failed' };

/**
 * Loads `path` in `root`, and loads it again whenever main reports a change to
 * it, for as long as the caller is mounted. `load` must be stable. A slower
 * earlier response never overwrites a later one, and a reload keeps showing
 * the previous value until the new one arrives.
 */
export function useWatchedLoad<T>(root: string, path: string, load: (root: string, path: string) => Promise<T>): Watched<T> {
  const [state, setState] = useState<Watched<T>>({ status: 'loading' });
  useEffect(() => {
    const files = window.fractal.files;
    const watchId = crypto.randomUUID();
    let current = true;
    let latest = 0;
    const refresh = () => {
      const request = ++latest;
      load(root, path).then(
        (value) => { if (current && request === latest) setState({ status: 'ready', value }); },
        () => { if (current && request === latest) setState({ status: 'failed' }); },
      );
    };
    setState({ status: 'loading' });
    const off = files.onEvent((event) => { if (event.watchId === watchId) refresh(); });
    files.watch(watchId, root, path).catch(() => undefined);
    refresh();
    return () => {
      current = false;
      off();
      files.unwatch(watchId).catch(() => undefined);
    };
  }, [root, path, load]);
  return state;
}
```

`src/components/right-panel/files/file-tree.tsx`:

```tsx
import { ChevronRight, File, Folder, FolderOpen } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { absoluteProjectPath } from '@/renderer/file-display';
import { FILTER_RESULT_LIMIT, filterPaths } from '@/renderer/file-filter';
import { useWatchedLoad } from '@/renderer/use-watched-load';
import { FILE_LIST_MAX_ENTRIES, type FileList } from '@/shared/files-contract';

export type OpenFile = (path: string, options: { pinned: boolean }) => void;

const listDirectory = (root: string, path: string) => window.fractal.files.listDirectory(root, path);
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const indent = (depth: number): CSSProperties => ({ paddingLeft: 8 + depth * 12 });
const ROW = 'flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left focus-visible:outline-2 focus-visible:outline-ring enabled:hover:bg-sidebar-accent';

type TreeProps = { root: string; expanded: ReadonlySet<string>; onToggle: (path: string) => void; selectedPath: string | null; onOpen: OpenFile };

export function FileTree({ root, selectedPath, onOpen }: { root: string; selectedPath: string | null; onOpen: OpenFile }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const onToggle = (path: string) => setExpanded((previous) => {
    const next = new Set(previous);
    if (!next.delete(path)) next.add(path);
    return next;
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 p-2">
        <Input
          aria-label="Filter files"
          className="h-7 text-xs"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); }}
          placeholder="Filter files…"
          value={query}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2 text-sm">
        {query.trim()
          ? <FilterResults onOpen={onOpen} query={query} root={root} selectedPath={selectedPath} />
          : <FolderNode depth={0} expanded={expanded} onOpen={onOpen} onToggle={onToggle} path="" root={root} selectedPath={selectedPath} />}
      </div>
    </div>
  );
}

// Mounted while its folder is expanded, so the folder is loaded and watched exactly as long as it is shown.
function FolderNode({ path, depth, ...props }: TreeProps & { path: string; depth: number }) {
  const loaded = useWatchedLoad(props.root, path, listDirectory);
  if (loaded.status === 'loading') return depth === 0 ? <p className="px-2 py-1 text-xs text-muted-foreground">Loading…</p> : null;
  if (loaded.status === 'failed') return <p className="py-1 text-xs text-muted-foreground" style={indent(depth)}>Couldn&apos;t read this folder</p>;
  return (
    <ul>
      {loaded.value.map((entry) => {
        const childPath = join(path, entry.name);
        if (entry.kind === 'file') {
          return (
            <li key={entry.name}>
              <FileRow depth={depth} ignored={entry.ignored} label={entry.name} onOpen={props.onOpen} outside={entry.outside} path={childPath} root={props.root} selected={childPath === props.selectedPath} />
            </li>
          );
        }
        const open = props.expanded.has(childPath);
        const Icon = open ? FolderOpen : Folder;
        return (
          <li key={entry.name}>
            <button
              aria-expanded={entry.outside ? undefined : open}
              className={cn(ROW, entry.ignored && 'text-muted-foreground', entry.outside && 'cursor-default opacity-60')}
              disabled={entry.outside}
              onClick={() => props.onToggle(childPath)}
              style={indent(depth)}
              title={entry.outside ? 'Outside the project' : undefined}
              type="button"
            >
              <ChevronRight aria-hidden className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
              <Icon aria-hidden className="size-4 shrink-0" />
              <span className="truncate">{entry.name}</span>
            </button>
            {open && <FolderNode {...props} depth={depth + 1} path={childPath} />}
          </li>
        );
      })}
    </ul>
  );
}

function FileRow({ root, path, label, depth, ignored = false, outside = false, selected, onOpen }: {
  root: string; path: string; label: string; depth: number; ignored?: boolean; outside?: boolean; selected: boolean; onOpen: OpenFile;
}) {
  const row = (
    <button
      aria-current={selected ? 'true' : undefined}
      className={cn(ROW, selected && 'bg-sidebar-accent text-sidebar-accent-foreground', ignored && 'text-muted-foreground', outside && 'cursor-default opacity-60')}
      disabled={outside}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onOpen(path, { pinned: true });
      }}
      onClick={() => onOpen(path, { pinned: false })}
      onDoubleClick={() => onOpen(path, { pinned: true })}
      // A middle press would otherwise paste the primary selection on Linux.
      onMouseDown={(event: MouseEvent) => { if (event.button === 1) event.preventDefault(); }}
      style={indent(depth)}
      title={outside ? 'Outside the project' : path}
      type="button"
    >
      <span aria-hidden className="size-3.5 shrink-0" />
      <File aria-hidden className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
  if (outside) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpen(path, { pinned: true })}>Open in new tab</ContextMenuItem>
        <ContextMenuItem onSelect={() => { void navigator.clipboard.writeText(absoluteProjectPath(root, path)); }}>Copy path</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Mounted while the filter has text: the list is fetched each time the filter opens, then filtered locally.
function FilterResults({ root, query, selectedPath, onOpen }: { root: string; query: string; selectedPath: string | null; onOpen: OpenFile }) {
  const [list, setList] = useState<FileList | 'loading' | 'failed'>('loading');
  useEffect(() => {
    let current = true;
    window.fractal.files.listFiles(root).then(
      (value) => { if (current) setList(value); },
      () => { if (current) setList('failed'); },
    );
    return () => { current = false; };
  }, [root]);
  const matches = useMemo(() => (typeof list === 'object' ? filterPaths(list.paths, query, FILTER_RESULT_LIMIT) : []), [list, query]);
  if (list === 'loading') return <p className="px-2 py-1 text-xs text-muted-foreground">Listing files…</p>;
  if (list === 'failed') return <p className="px-2 py-1 text-xs text-muted-foreground">Couldn&apos;t list this project&apos;s files</p>;
  return (
    <>
      {matches.length === 0
        ? <p className="px-2 py-1 text-xs text-muted-foreground">No matching files</p>
        : (
          <ul>
            {matches.map((path) => (
              <li key={path}><FileRow depth={0} label={path} onOpen={onOpen} path={path} root={root} selected={path === selectedPath} /></li>
            ))}
          </ul>
        )}
      {list.truncated && <p className="px-2 pt-2 text-xs text-muted-foreground">Searched the first {FILE_LIST_MAX_ENTRIES.toLocaleString('en-US')} files.</p>}
    </>
  );
}
```

- [ ] **Step 4: Run the tests, lint, and typecheck**

Run: `pnpm vitest run src/renderer/file-filter.test.ts src/components/right-panel/files && pnpm lint && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/file-filter.ts src/renderer/file-filter.test.ts src/renderer/use-watched-load.ts src/components/right-panel/files/file-tree.tsx src/components/right-panel/files/file-tree.test.tsx
git commit -m "feat(files): add the file tree with lazy folders, live reloads, and a name filter"
```

---

### Task 11: Open menu and file viewer

**Files:**
- Create: `src/components/right-panel/files/open-menu.tsx`, `src/components/right-panel/files/open-menu.test.tsx`
- Create: `src/components/right-panel/files/file-viewer.tsx`, `src/components/right-panel/files/file-viewer.test.tsx`

**Interfaces:**
- Consumes: `window.fractal.files`, `window.fractal.settings` (`fileOpener`, Task 6); `useWatchedLoad` (Task 10); `useHighlightedTokens`, `TokenLine`, `languageFor`, `formatSize`, `basename`, `absoluteProjectPath` (Task 1); `FILE_HIGHLIGHT_MAX_BYTES`, `FileContent`, `EditorInfo`, `FileOpenerId`, `OpenAction` (Task 2)
- Produces: `defaultOpener(remembered: FileOpenerId | null, editors: EditorInfo[]): FileOpenerId`, `OpenMenu({ root, path, line })`, `FileViewer({ root, path })`

- [ ] **Step 1: Write the failing tests**

`src/components/right-panel/files/open-menu.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';
import type { EditorInfo } from '@/shared/files-contract';
import { defaultOpener, OpenMenu } from './open-menu';

const editors: EditorInfo[] = [{ id: 'vscode', label: 'VS Code' }, { id: 'zed', label: 'Zed' }];
let open: Mock;
let set: Mock;
beforeEach(() => {
  open = vi.fn(async () => ({ ok: true }));
  set = vi.fn(async () => ({}));
  Object.defineProperty(window, 'fractal', { configurable: true, value: {
    files: { editors: vi.fn(async () => editors), open },
    settings: { get: vi.fn(async () => ({ fileOpener: 'zed' })), set },
  } });
});
afterEach(cleanup);

test('runs the remembered opener while it is still available, else the first editor, else the default app', () => {
  expect(defaultOpener('zed', editors)).toBe('zed');
  expect(defaultOpener('system', editors)).toBe('system');
  expect(defaultOpener('cursor', editors)).toBe('vscode');
  expect(defaultOpener(null, [])).toBe('system');
});

test('opens with the remembered editor at the current line', async () => {
  const user = userEvent.setup();
  render(<OpenMenu line={7} path="src/a.ts" root="/repo" />);
  await user.click(await screen.findByRole('button', { name: 'Open in Zed' }));
  expect(open).toHaveBeenCalledWith('zed', '/repo', 'src/a.ts', 7);
  expect(set).not.toHaveBeenCalled();
});

test('remembers an editor chosen from the menu once it opens, but not Show in folder', async () => {
  const user = userEvent.setup();
  render(<OpenMenu path="src/a.ts" root="/repo" />);
  await screen.findByRole('button', { name: 'Open in Zed' });
  await user.click(screen.getByRole('button', { name: 'Choose how to open' }));
  await user.click(await screen.findByRole('menuitem', { name: 'VS Code' }));
  expect(open).toHaveBeenCalledWith('vscode', '/repo', 'src/a.ts', undefined);
  await waitFor(() => expect(set).toHaveBeenCalledWith({ fileOpener: 'vscode' }));
  expect(screen.getByRole('button', { name: 'Open in VS Code' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Choose how to open' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Show in folder' }));
  expect(open).toHaveBeenLastCalledWith('reveal', '/repo', 'src/a.ts', undefined);
  expect(set).toHaveBeenCalledTimes(1);
});

test('shows why a file could not be opened', async () => {
  open.mockResolvedValue({ ok: false, message: 'Couldn\'t start Zed' });
  const user = userEvent.setup();
  render(<OpenMenu path="src/a.ts" root="/repo" />);
  await user.click(await screen.findByRole('button', { name: 'Open in Zed' }));
  expect((await screen.findByRole('status')).textContent).toBe('Couldn\'t start Zed');
  expect(set).not.toHaveBeenCalled();
});
```

`src/components/right-panel/files/file-viewer.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';
import type { FileContent, FilesEvent } from '@/shared/files-contract';
import { FileViewer } from './file-viewer';

vi.mock('./open-menu', () => ({ OpenMenu: ({ line }: { line?: number }) => <div data-line={line ?? ''} data-testid="open-menu" /> }));

const listeners = new Set<(event: FilesEvent) => void>();
let readFile: Mock;
let writeText: Mock;
beforeEach(() => {
  listeners.clear();
  readFile = vi.fn(async (): Promise<FileContent> => ({ kind: 'text', content: 'one\ntwo\nthree', size: 13 }));
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(window, 'fractal', { configurable: true, value: { files: {
    readFile,
    watch: vi.fn(async () => undefined),
    unwatch: vi.fn(async () => undefined),
    onEvent: vi.fn((listener: (event: FilesEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
  } } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  // jsdom has no layout; the virtualizer measures its scroll element through these.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const row = (line: number) => document.querySelector(`[data-line="${line}"]`) as HTMLElement;

test('shows the breadcrumb and numbered lines, and marks the clicked line as current', async () => {
  render(<FileViewer path="src/notes.unknownext" root="/work/repo" />);
  expect(await screen.findByText('two')).toBeTruthy();
  expect(screen.getByRole('navigation', { name: 'File path' }).textContent).toBe('repo›src›notes.unknownext');
  fireEvent.click(row(2));
  expect(row(2).getAttribute('aria-current')).toBe('true');
  expect(screen.getByTestId('open-menu').getAttribute('data-line')).toBe('2');
});

test('reads the file again when main reports a change', async () => {
  render(<FileViewer path="notes.unknownext" root="/repo" />);
  await screen.findByText('two');
  readFile.mockResolvedValue({ kind: 'text', content: 'changed', size: 7 });
  const watchId = (window.fractal.files.watch as Mock).mock.calls[0][0] as string;
  act(() => { for (const listener of listeners) listener({ type: 'changed', watchId }); });
  expect(await screen.findByText('changed')).toBeTruthy();
});

test.each([
  [{ kind: 'binary', size: 1_258_291 }, 'Binary file · 1.2 MiB', true],
  [{ kind: 'too-large', size: 14 * 1024 * 1024 }, 'Too large to preview · 14.0 MiB', true],
  [{ kind: 'missing' }, 'This file no longer exists', false],
  [{ kind: 'unreadable' }, 'This file cannot be read', false],
] as Array<[FileContent, string, boolean]>)('explains content it does not show as text: %j', async (content, message, offersOpen) => {
  readFile.mockResolvedValue(content);
  render(<FileViewer path="a.bin" root="/repo" />);
  expect(await screen.findByText(message)).toBeTruthy();
  // The header always has an Open menu; binary and too-large files get a second one under the message.
  expect(screen.getAllByTestId('open-menu')).toHaveLength(offersOpen ? 2 : 1);
});

test('copies the file\'s absolute path', async () => {
  render(<FileViewer path="src/a.unknownext" root="/repo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy path' }));
  expect(writeText).toHaveBeenCalledWith('/repo/src/a.unknownext');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/components/right-panel/files/open-menu.test.tsx src/components/right-panel/files/file-viewer.test.tsx`
Expected: FAIL, because the modules cannot be found.

- [ ] **Step 3: Implement the Open menu**

`src/components/right-panel/files/open-menu.tsx`:

```tsx
import { ChevronDown, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { EditorInfo, FileOpenerId, OpenAction } from '@/shared/files-contract';

const SYSTEM_LABEL = 'System default';

// Main detects editors once per launch; the first menu to ask keeps the answer.
let editorsOnce: Promise<EditorInfo[]> | undefined;
const loadEditors = () => (editorsOnce ??= window.fractal.files.editors().catch((): EditorInfo[] => []));

/** What the Open button runs: the remembered choice while it is still available, else the first editor, else the default app. */
export function defaultOpener(remembered: FileOpenerId | null, editors: EditorInfo[]): FileOpenerId {
  if (remembered === 'system' || (remembered !== null && editors.some((editor) => editor.id === remembered))) return remembered;
  return editors[0]?.id ?? 'system';
}

export function OpenMenu({ root, path, line }: { root: string; path: string; line?: number }) {
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [remembered, setRemembered] = useState<FileOpenerId | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void loadEditors().then((list) => { if (current) setEditors(list); });
    window.fractal.settings.get().then(
      (settings) => { if (current) setRemembered(settings.fileOpener); },
      () => undefined,
    );
    return () => { current = false; };
  }, []);

  const opener = defaultOpener(remembered, editors);
  const labelFor = (id: FileOpenerId) => (id === 'system' ? SYSTEM_LABEL : editors.find((editor) => editor.id === id)?.label ?? id);
  const run = async (action: OpenAction) => {
    setMessage(null);
    const result = await window.fractal.files.open(action, root, path, line).catch(() => ({ ok: false as const, message: 'Couldn\'t open this file' }));
    if (!result.ok) { setMessage(result.message); return; }
    // Show in folder does not open the file, so it never becomes the button's action.
    if (action !== 'reveal' && action !== remembered) {
      setRemembered(action);
      window.fractal.settings.set({ fileOpener: action }).catch(() => undefined);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2">
      {message && <span className="text-xs text-destructive" role="status">{message}</span>}
      <ButtonGroup>
        <Button aria-label={`Open in ${labelFor(opener)}`} className="h-7 gap-1.5 px-2 text-xs" onClick={() => { void run(opener); }} size="sm" type="button" variant="outline">
          <ExternalLink aria-hidden className="size-3.5" />
          Open
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label="Choose how to open" className="h-7 px-1.5" size="sm" type="button" variant="outline">
              <ChevronDown aria-hidden className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {editors.map((editor) => (
              <DropdownMenuItem key={editor.id} onSelect={() => { void run(editor.id); }}>{editor.label}</DropdownMenuItem>
            ))}
            {editors.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => { void run('system'); }}>{SYSTEM_LABEL}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { void run('reveal'); }}>Show in folder</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
    </div>
  );
}
```

- [ ] **Step 4: Implement the viewer**

`src/components/right-panel/files/file-viewer.tsx`:

```tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, Copy } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TokenLine, useHighlightedTokens } from '@/components/code/highlighted-tokens';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { absoluteProjectPath, basename, formatSize, languageFor } from '@/renderer/file-display';
import { useWatchedLoad } from '@/renderer/use-watched-load';
import { FILE_HIGHLIGHT_MAX_BYTES, type FileContent } from '@/shared/files-contract';
import { OpenMenu } from './open-menu';

const readFile = (root: string, path: string) => window.fractal.files.readFile(root, path);
// text-xs with leading-5: every line is 20px, so rows never need measuring.
const LINE_HEIGHT = 20;
const TAB_WIDTH = 8;

export function FileViewer({ root, path }: { root: string; path: string }) {
  const loaded = useWatchedLoad(root, path, readFile);
  const [line, setLine] = useState<number | undefined>();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-sidebar-border px-3">
        <Breadcrumb path={path} root={root} />
        <CopyPath path={absoluteProjectPath(root, path)} />
        <OpenMenu line={line} path={path} root={root} />
      </div>
      <div className="min-h-0 flex-1">
        {loaded.status === 'loading' && <Message>Reading file…</Message>}
        {loaded.status === 'failed' && <Message>This file cannot be read</Message>}
        {loaded.status === 'ready' && <Content content={loaded.value} line={line} onLine={setLine} path={path} root={root} />}
      </div>
    </div>
  );
}

function Breadcrumb({ root, path }: { root: string; path: string }) {
  const segments = [basename(root), ...path.split('/')];
  return (
    <nav aria-label="File path" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden className="mx-1">›</span>}
          <span className={index === segments.length - 1 ? 'text-foreground' : undefined}>{segment}</span>
        </Fragment>
      ))}
    </nav>
  );
}

function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      aria-label="Copy path"
      className="size-7 shrink-0"
      onClick={() => { navigator.clipboard.writeText(path).then(() => setCopied(true), () => undefined); }}
      size="icon"
      type="button"
      variant="ghost"
    >
      {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
    </Button>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <p className="p-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function Content({ content, root, path, line, onLine }: { content: FileContent; root: string; path: string; line?: number; onLine: (line: number) => void }) {
  switch (content.kind) {
    case 'text': return <Lines line={line} onLine={onLine} path={path} size={content.size} text={content.content} />;
    case 'binary': return <Unshown path={path} root={root} text={`Binary file · ${formatSize(content.size)}`} />;
    case 'too-large': return <Unshown path={path} root={root} text={`Too large to preview · ${formatSize(content.size)}`} />;
    case 'missing': return <Message>This file no longer exists</Message>;
    case 'unreadable': return <Message>This file cannot be read</Message>;
  }
}

function Unshown({ root, path, text }: { root: string; path: string; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-sm text-muted-foreground">
      <p>{text}</p>
      <OpenMenu path={path} root={root} />
    </div>
  );
}

/** Columns in the longest line, with tabs at their CSS default width, so the content can scroll sideways. */
const longestLine = (lines: string[]) => lines.reduce((longest, text) => Math.max(longest, text.length + (TAB_WIDTH - 1) * (text.split('\t').length - 1)), 0);

function Lines({ text, size, path, line, onLine }: { text: string; size: number; path: string; line?: number; onLine: (line: number) => void }) {
  const lines = useMemo(() => text.split(/\r?\n/), [text]);
  const tokens = useHighlightedTokens(text, size <= FILE_HIGHLIGHT_MAX_BYTES ? languageFor(path) : undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: lines.length, getScrollElement: () => scroller.current, estimateSize: () => LINE_HEIGHT, overscan: 20 });
  const gutter = `${String(lines.length).length + 2}ch`;
  // Rows are absolutely positioned, so the content's width has to be set rather than measured.
  const width = `calc(${longestLine(lines)}ch + ${gutter} + 2rem)`;
  return (
    <div aria-label={`${basename(path)} contents`} className="h-full overflow-auto font-mono text-xs leading-5" ref={scroller} role="region">
      <div className="relative min-w-full" style={{ height: virtualizer.getTotalSize(), width }}>
        {virtualizer.getVirtualItems().map((item) => {
          const number = item.index + 1;
          const current = number === line;
          return (
            <div
              aria-current={current ? 'true' : undefined}
              className={cn('absolute left-0 flex w-full whitespace-pre', current && 'bg-sidebar-accent')}
              data-line={number}
              key={item.key}
              onClick={() => onLine(number)}
              style={{ top: item.start, height: LINE_HEIGHT }}
            >
              <span aria-hidden className={cn('sticky left-0 shrink-0 pr-3 pl-2 text-right text-muted-foreground select-none', current ? 'bg-sidebar-accent' : 'bg-sidebar')} style={{ width: gutter }}>{number}</span>
              <span className="pr-4">{tokens?.[item.index] ? <TokenLine tokens={tokens[item.index]} /> : lines[item.index]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the tests, lint, and typecheck**

Run: `pnpm vitest run src/components/right-panel/files && pnpm lint && pnpm exec tsc --noEmit`
Expected: PASS. If the breadcrumb `textContent` assertion fails on whitespace, check that no stray spaces are being rendered between the spans. Don't loosen the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/components/right-panel/files/open-menu.tsx src/components/right-panel/files/open-menu.test.tsx src/components/right-panel/files/file-viewer.tsx src/components/right-panel/files/file-viewer.test.tsx
git commit -m "feat(files): add the file viewer and its Open menu

- show highlighted, virtualised lines with a gutter and a current line
- re-read on change, and explain binary, too-large, missing, and unreadable files
- hand the file to a detected editor, the default app, or its folder, remembering the editor that worked"
```

---

### Task 12: Files pane and panel wiring

**Files:**
- Modify: `src/renderer/right-panel-layout.ts`, `src/renderer/right-panel-layout.test.ts`
- Create: `src/components/right-panel/files/files-pane.tsx`, `src/components/right-panel/files/files-pane.test.tsx`
- Modify: `src/components/right-panel/tool-entries.tsx`, `src/components/right-panel/tool-entries.test.tsx`
- Modify: `src/components/right-panel/terminal-tabs.tsx`, `src/components/right-panel/terminal-tabs.test.tsx`
- Modify: `src/components/right-workspace.tsx`, `src/components/right-workspace.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 8–11
- Produces: `FILES_TREE_DOCK_MIN_WIDTH = 560`, `FILES_TREE_WIDTH = 240`, `filesTreeDocked(panelWidth: number): boolean`; `FilesPane({ tabs, selected, docked, dockedTreeOpen, overlayOpen, onOpenFile, onCloseOverlay })`; `ToolList({ onTerminal, onFiles, filesAvailable })` and `ToolMenuItems({ onTerminal, onFiles, filesAvailable })`

- [ ] **Step 1: Write the failing tests**

Add to `src/renderer/right-panel-layout.test.ts`:

```ts
test('docks the file tree beside the viewer only in a wide enough panel', () => {
  expect(filesTreeDocked(FILES_TREE_DOCK_MIN_WIDTH)).toBe(true);
  expect(filesTreeDocked(FILES_TREE_DOCK_MIN_WIDTH - 1)).toBe(false);
});
```

Import `FILES_TREE_DOCK_MIN_WIDTH` and `filesTreeDocked` there.

`src/components/right-panel/files/files-pane.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { FilePanelTab } from '@/renderer/panel-tabs';
import { FilesPane } from './files-pane';

vi.mock('./file-tree', () => ({
  FileTree: ({ root, onOpen }: { root: string; onOpen: (path: string, options: { pinned: boolean }) => void }) => (
    <button onClick={() => onOpen('src/b.ts', { pinned: false })} type="button">Tree of {root}</button>
  ),
}));
vi.mock('./file-viewer', () => ({ FileViewer: ({ path }: { path: string }) => <p>Viewing {path}</p> }));

afterEach(cleanup);

const a: FilePanelTab = { kind: 'file', id: 'a', projectPath: '/repo', path: 'src/a.ts', preview: true };
const empty: FilePanelTab = { kind: 'file', id: 'e', projectPath: '/other', path: null, preview: true };
const props = { tabs: [a, empty], docked: true, dockedTreeOpen: true, overlayOpen: false, onOpenFile: vi.fn(), onCloseOverlay: vi.fn() };
const visible = (text: string) => !screen.getByText(text).closest('[hidden]');

test('docked, shows the selected project\'s tree beside its file, and an empty tab asks for a file', () => {
  const { rerender } = render(<FilesPane {...props} selected={a} />);
  expect(visible('Tree of /repo')).toBe(true);
  expect(visible('Tree of /other')).toBe(false);
  expect(visible('Viewing src/a.ts')).toBe(true);
  rerender(<FilesPane {...props} dockedTreeOpen={false} selected={empty} />);
  expect(screen.getByText('Select a file')).toBeTruthy();
  expect(visible('Tree of /other')).toBe(false);
});

test('narrow, opens the tree over the viewer on request or for an empty tab, and closes it once a file is chosen', async () => {
  const onOpenFile = vi.fn();
  const onCloseOverlay = vi.fn();
  const { rerender } = render(<FilesPane {...props} docked={false} onCloseOverlay={onCloseOverlay} onOpenFile={onOpenFile} selected={a} />);
  expect(visible('Tree of /repo')).toBe(false);
  rerender(<FilesPane {...props} docked={false} onCloseOverlay={onCloseOverlay} onOpenFile={onOpenFile} overlayOpen selected={a} />);
  expect(visible('Tree of /repo')).toBe(true);
  await userEvent.setup().click(screen.getByText('Tree of /repo'));
  expect(onOpenFile).toHaveBeenCalledWith('/repo', 'src/b.ts', false);
  expect(onCloseOverlay).toHaveBeenCalled();
  rerender(<FilesPane {...props} docked={false} onCloseOverlay={onCloseOverlay} onOpenFile={onOpenFile} selected={empty} />);
  expect(visible('Tree of /other')).toBe(true);
});
```

Replace the test in `src/components/right-panel/tool-entries.test.tsx` with:

```tsx
test('lists every tool in order, with Terminal and Files available', async () => {
  const onTerminal = vi.fn();
  const onFiles = vi.fn();
  render(<ToolList filesAvailable onFiles={onFiles} onTerminal={onTerminal} />);
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'ReviewSoon', 'TerminalCtrl+`', 'BrowserSoon', 'Files', 'Side chatSoon',
  ]);
  for (const name of ['Review', 'Browser', 'Side chat']) {
    expect(screen.getByRole('menuitem', { name }).hasAttribute('disabled')).toBe(true);
  }
  const terminal = screen.getByRole('menuitem', { name: 'Terminal' });
  expect(terminal.getAttribute('aria-keyshortcuts')).toBe('Control+`');
  const user = userEvent.setup();
  await user.click(terminal);
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  expect(onTerminal).toHaveBeenCalledTimes(1);
  expect(onFiles).toHaveBeenCalledTimes(1);
});

test('disables Files until there is a project', () => {
  render(<ToolList filesAvailable={false} onFiles={vi.fn()} onTerminal={vi.fn()} />);
  const files = screen.getByRole('menuitem', { name: 'Files' });
  expect(files.hasAttribute('disabled')).toBe(true);
  expect(files.textContent).toBe('FilesOpen a project first');
});
```

In `src/components/right-panel/terminal-tabs.test.tsx`, delete the test `'selects, closes, closes on middle-click, and marks exited shells'` (`panel-tabs.test.tsx` covers it now) and remove the now-unused imports (`fireEvent`, `userEvent`, `vi`, `TooltipProvider`, `TerminalTabs`).

In `src/components/right-workspace.test.tsx`:
- Add a `FilesPane` mock beside the `TerminalView` mock:

```tsx
vi.mock('./right-panel/files/files-pane', () => ({
  FilesPane: ({ selected, docked, dockedTreeOpen, onOpenFile }: {
    selected?: { projectPath: string; path: string | null }; docked: boolean; dockedTreeOpen: boolean;
    onOpenFile: (projectPath: string, path: string, pinned: boolean) => void;
  }) => (
    <div data-docked={docked} data-testid="files-pane" data-tree-open={dockedTreeOpen}>
      {selected && (
        <>
          <button onClick={() => onOpenFile(selected.projectPath, 'src/a.ts', false)} type="button">Click a.ts</button>
          <button onClick={() => onOpenFile(selected.projectPath, 'src/b.ts', false)} type="button">Click b.ts</button>
        </>
      )}
    </div>
  ),
}));
```

- Give `Harness` a `projectPath` prop defaulting to `'/repo'` and pass it through: `function Harness({ withInset = false, onResizingChange = () => undefined, projectPath = '/repo' as string | null }: { withInset?: boolean; onResizingChange?: (resizing: boolean) => void; projectPath?: string | null })` and `projectPath={projectPath}` on `RightWorkspace`.
- Add the tests:

```tsx
test('Files is unavailable without a project', async () => {
  const user = userEvent.setup();
  render(<Harness projectPath={null} />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(screen.getByRole('menuitem', { name: 'Files' }).hasAttribute('disabled')).toBe(true);
});

test('opens Files, fills and replaces the preview tab, pins it, and reuses the most recent file tab', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  expect(screen.getByRole('tab', { name: 'Files (preview)' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Click a.ts' }));
  expect(screen.getByRole('tab', { name: 'a.ts (preview)' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Click b.ts' }));
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  await user.dblClick(screen.getByRole('tab', { name: 'b.ts (preview)' }));
  expect(screen.getByRole('tab', { name: 'b.ts' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Click a.ts' }));
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['b.ts', 'a.ts (preview)']);
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  expect(screen.getAllByRole('tab')).toHaveLength(3);
  expect(screen.getByRole('tab', { name: 'a.ts (preview)' }).getAttribute('aria-selected')).toBe('true');
});

test('shows the tree toggle only on file tabs, and Ctrl+` returns to the last terminal', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.queryByRole('button', { name: /file tree/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  // Narrow, a tab with no file yet always shows the tree.
  expect(screen.getByRole('button', { name: 'Hide file tree' }).getAttribute('aria-pressed')).toBe('true');
  await user.click(screen.getByRole('button', { name: 'Click a.ts' }));
  const toggle = screen.getByRole('button', { name: 'Show file tree' });
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  await user.click(toggle);
  expect(screen.getByRole('button', { name: 'Hide file tree' }).getAttribute('aria-pressed')).toBe('true');
  pressToggle(document.body);
  expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true');
});
```

The workspace in these tests opens at 320px, below the 560px docking width, so the toggle drives the overlay. The mocked `FilesPane` never closes the overlay itself, so after a file is opened the toggle starts unpressed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/renderer/right-panel-layout.test.ts src/components/right-panel src/components/right-workspace.test.tsx`
Expected: FAIL. `filesTreeDocked` and `FilesPane` are missing, Files is still "Soon", and the workspace has no file tabs.

- [ ] **Step 3: Implement the layout rule, the pane, and the tool entries**

Add to `src/renderer/right-panel-layout.ts`:

```ts
/** From this panel width a Files tab's tree sits beside the viewer; narrower, it opens over it. A starting value, tuned by feel. */
export const FILES_TREE_DOCK_MIN_WIDTH = 560;
export const FILES_TREE_WIDTH = 240;

export const filesTreeDocked = (panelWidth: number): boolean => panelWidth >= FILES_TREE_DOCK_MIN_WIDTH;
```

`src/components/right-panel/files/files-pane.tsx`:

```tsx
import { cn } from '@/lib/utils';
import { basename } from '@/renderer/file-display';
import type { FilePanelTab } from '@/renderer/panel-tabs';
import { FILES_TREE_WIDTH } from '@/renderer/right-panel-layout';
import { FileTree } from './file-tree';
import { FileViewer } from './file-viewer';

/**
 * Every open file tab's content, plus one tree per project, all kept mounted
 * so folders stay expanded and viewers keep their place while hidden. The
 * tree sits beside the viewer when docked; otherwise it covers the viewer
 * when asked for, and always while the selected tab has no file yet.
 */
export function FilesPane({ tabs, selected, docked, dockedTreeOpen, overlayOpen, onOpenFile, onCloseOverlay }: {
  tabs: FilePanelTab[];
  selected: FilePanelTab | undefined;
  docked: boolean;
  dockedTreeOpen: boolean;
  overlayOpen: boolean;
  onOpenFile: (projectPath: string, path: string, pinned: boolean) => void;
  onCloseOverlay: () => void;
}) {
  const projects = [...new Set(tabs.map((tab) => tab.projectPath))];
  const treeVisible = selected !== undefined && (docked ? dockedTreeOpen : overlayOpen || selected.path === null);
  return (
    <div className="relative flex h-full min-h-0">
      {projects.map((projectPath) => (
        <div
          aria-label={`Files in ${basename(projectPath)}`}
          className={cn('min-h-0 bg-sidebar', docked ? 'shrink-0 border-r border-sidebar-border' : 'absolute inset-0 z-10')}
          hidden={!treeVisible || selected?.projectPath !== projectPath}
          key={projectPath}
          role="region"
          style={docked ? { width: FILES_TREE_WIDTH } : undefined}
        >
          <FileTree
            onOpen={(path, { pinned }) => {
              onOpenFile(projectPath, path, pinned);
              if (!docked) onCloseOverlay();
            }}
            root={projectPath}
            selectedPath={selected?.projectPath === projectPath ? selected.path : null}
          />
        </div>
      ))}
      <div className="min-w-0 flex-1">
        {tabs.map((tab) => (
          <div aria-labelledby={tab.id} className="h-full" hidden={selected?.id !== tab.id} id={`panel-${tab.id}`} key={tab.id} role="tabpanel">
            {tab.path === null
              ? <p className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a file</p>
              : <FileViewer key={tab.path} path={tab.path} root={tab.projectPath} />}
          </div>
        ))}
      </div>
    </div>
  );
}
```

Replace `src/components/right-panel/tool-entries.tsx` with:

```tsx
import { FileDiff, Folder, Globe, MessageCirclePlus, SquareTerminal, type LucideIcon } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

type ToolId = 'review' | 'terminal' | 'browser' | 'files' | 'side-chat';
type ToolEntry = { id: ToolId; label: string; Icon: LucideIcon };

// Terminal and Files exist; the others are listed so the panel shows its intended shape before they land.
const TOOL_ENTRIES: readonly ToolEntry[] = [
  { id: 'review', label: 'Review', Icon: FileDiff },
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminal },
  { id: 'browser', label: 'Browser', Icon: Globe },
  { id: 'files', label: 'Files', Icon: Folder },
  { id: 'side-chat', label: 'Side chat', Icon: MessageCirclePlus },
];

type Handlers = { onTerminal: () => void; onFiles: () => void; filesAvailable: boolean };
type State = { onSelect?: () => void; hint?: string; shortcut?: string };

function stateOf(id: ToolId, { onTerminal, onFiles, filesAvailable }: Handlers): State {
  if (id === 'terminal') return { onSelect: onTerminal, hint: 'Ctrl+`', shortcut: 'Control+`' };
  if (id === 'files') return filesAvailable ? { onSelect: onFiles } : { hint: 'Open a project first' };
  return { hint: 'Soon' };
}

// The hint is decoration for sighted users; the shortcut itself is exposed
// through `aria-keyshortcuts` and unavailability through `disabled`.
function Hint({ text, shortcut }: { text?: string; shortcut: boolean }) {
  if (!text) return null;
  return (
    <span aria-hidden className={cn('ml-auto rounded border border-sidebar-border px-1.5 text-[11px] leading-4 text-muted-foreground', shortcut ? 'font-mono' : 'font-sans')}>
      {text}
    </span>
  );
}

export function ToolList(handlers: Handlers) {
  return (
    <div aria-label="Add a tool" className="w-full max-w-sm space-y-2" role="menu">
      {TOOL_ENTRIES.map(({ id, label, Icon }) => {
        const { onSelect, hint, shortcut } = stateOf(id, handlers);
        return (
          <button
            aria-keyshortcuts={shortcut}
            className={cn(
              'flex h-10 w-full items-center gap-3 rounded-lg bg-sidebar-accent/60 px-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring',
              onSelect ? 'hover:bg-sidebar-accent' : 'cursor-default text-muted-foreground',
            )}
            disabled={!onSelect}
            key={id}
            onClick={onSelect}
            role="menuitem"
            type="button"
          >
            <Icon aria-hidden className="size-4" />
            {label}
            <Hint shortcut={shortcut !== undefined} text={hint} />
          </button>
        );
      })}
    </div>
  );
}

export function ToolMenuItems(handlers: Handlers) {
  return (
    <>
      {TOOL_ENTRIES.map(({ id, label, Icon }) => {
        const { onSelect, hint, shortcut } = stateOf(id, handlers);
        return (
          <DropdownMenuItem
            aria-keyshortcuts={shortcut}
            // The menu item's default dims disabled entries to 50%; the spec
            // keeps them readable in the secondary text colour instead.
            className="gap-3 data-[disabled]:text-muted-foreground data-[disabled]:opacity-100"
            disabled={!onSelect}
            key={id}
            onSelect={onSelect}
          >
            <Icon aria-hidden />
            {label}
            <Hint shortcut={shortcut !== undefined} text={hint} />
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
```

In `src/components/right-panel/terminal-tabs.tsx`, delete the `TerminalTabs` component and the imports only it used (`SquareTerminal`, `X`, and the tooltip imports). Keep `TerminalTab`, `terminalTabLabel`, and `nextTerminalNumber`.

- [ ] **Step 4: Rewire the right workspace**

In `src/components/right-workspace.tsx`:

Replace the imports from `tool-entries`, `terminal-tabs`, and `right-panel-layout`, and add the new ones:

```tsx
import { ListTree, Plus } from 'lucide-react';
import { FilesPane } from '@/components/right-panel/files/files-pane';
import { PanelTabs } from '@/components/right-panel/panel-tabs';
import { ToolList, ToolMenuItems } from '@/components/right-panel/tool-entries';
import { activeTerminalId, addTerminalTab, closeTab, emptyPanelTabs, openFile, openFilesTool, pinTab, selectTab, updateTerminalTab, type FilePanelTab, type PanelTabsState, type TerminalPanelTab } from '@/renderer/panel-tabs';
import { PANEL_MIN_WIDTH, clampPanelWidth, defaultPanelWidth, filesTreeDocked, panelLayout } from '@/renderer/right-panel-layout';
```

(Remove the old `import { Plus } from 'lucide-react';`, and the imports of `nextTerminalNumber`, `TerminalTabs`, and `TerminalTab`.)

Replace the `tabs`/`selectedId` state and the `addTerminal`/`updateTab`/`closeTab` helpers with:

```tsx
  const [panelTabs, setPanelTabs] = useState<PanelTabsState>(emptyPanelTabs);
  const [dockedTreeOpen, setDockedTreeOpen] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState(false);
```

```tsx
  const { tabs, selectedId } = panelTabs;
  const selectedTab = tabs.find((tab) => tab.id === selectedId);
  const terminalTabs = tabs.filter((tab): tab is TerminalPanelTab => tab.kind === 'terminal');
  const fileTabs = tabs.filter((tab): tab is FilePanelTab => tab.kind === 'file');
  const selectedFileTab = selectedTab?.kind === 'file' ? selectedTab : undefined;
  const docked = filesTreeDocked(width);
  const treeShown = selectedFileTab !== undefined && (docked ? dockedTreeOpen : overlayOpen || selectedFileTab.path === null);

  const focusTerminal = (id: string) => setFocusRequest({ id, token: nextFocus.current++ });
  const addTerminal = () => {
    const id = crypto.randomUUID();
    setPanelTabs((previous) => addTerminalTab(previous, id, projectPath));
    focusTerminal(id);
  };
  const openFiles = () => {
    if (projectPath === null) return;
    const id = crypto.randomUUID();
    setPanelTabs((previous) => openFilesTool(previous, projectPath, id));
  };
  const openProjectFile = (project: string, path: string, pinned: boolean) => {
    const id = crypto.randomUUID();
    setPanelTabs((previous) => openFile(previous, project, path, pinned, id));
  };
  const toggleTree = () => (docked ? setDockedTreeOpen((value) => !value) : setOverlayOpen((value) => !value));
```

In `toggleTerminal.current`, replace the two lines that use `tabs.find(...)` with:

```tsx
    const terminalId = activeTerminalId(panelTabs);
    if (terminalId) {
      setPanelTabs((previous) => selectTab(previous, terminalId));
      focusTerminal(terminalId);
    } else addTerminal();
```

Replace the contents of the tab-row `div` (the one with `pr-10 pl-2`) with:

```tsx
              {selectedFileTab && (
                <Button aria-label={treeShown ? 'Hide file tree' : 'Show file tree'} aria-pressed={treeShown} className="size-8 shrink-0" onClick={toggleTree} size="icon" variant="ghost">
                  <ListTree aria-hidden className="size-4" />
                </Button>
              )}
              <PanelTabs
                onClose={(id) => setPanelTabs((previous) => closeTab(previous, id))}
                onPin={(id) => setPanelTabs((previous) => pinTab(previous, id))}
                onSelect={(id) => setPanelTabs((previous) => selectTab(previous, id))}
                selectedId={selectedId}
                tabs={tabs}
              />
              {tabs.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button aria-label="Add tool" className="size-8 shrink-0" size="icon" variant="ghost"><Plus aria-hidden className="size-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56"><ToolMenuItems filesAvailable={projectPath !== null} onFiles={openFiles} onTerminal={addTerminal} /></DropdownMenuContent>
                </DropdownMenu>
              )}
```

Replace the body below the tab row (the `tabs.length === 0 ? ... : ...` expression) with:

```tsx
            {tabs.length === 0 ? (
              <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                <ToolList filesAvailable={projectPath !== null} onFiles={openFiles} onTerminal={addTerminal} />
              </div>
            ) : (
              <div className="mx-2 mt-1 mb-2 min-h-0 flex-1 overflow-hidden rounded-md border border-sidebar-border">
                {terminalTabs.map((tab) => (
                  <div aria-labelledby={tab.id} className="h-full" hidden={selectedId !== tab.id} id={`terminal-panel-${tab.id}`} key={tab.id} role="tabpanel">
                    <TerminalView
                      cwd={tab.cwd}
                      focusToken={focusRequest?.id === tab.id ? focusRequest.token : 0}
                      id={tab.id}
                      onExitedChange={(exited) => setPanelTabs((previous) => updateTerminalTab(previous, tab.id, { exited }))}
                      onShellReady={({ shell, cwd }) => setPanelTabs((previous) => updateTerminalTab(previous, tab.id, { shell: shell.split(/[\\/]/).pop() || undefined, startedIn: cwd }))}
                      visible={open && selectedId === tab.id}
                    />
                  </div>
                ))}
                {fileTabs.length > 0 && (
                  <div className="h-full" hidden={!selectedFileTab}>
                    <FilesPane
                      docked={docked}
                      dockedTreeOpen={dockedTreeOpen}
                      onCloseOverlay={() => setOverlayOpen(false)}
                      onOpenFile={openProjectFile}
                      overlayOpen={overlayOpen}
                      selected={selectedFileTab}
                      tabs={fileTabs}
                    />
                  </div>
                )}
              </div>
            )}
```

- [ ] **Step 5: Run the full suite, lint, and typecheck**

Run: `pnpm test && pnpm lint && pnpm exec tsc --noEmit`
Expected: PASS, including every existing `right-workspace.test.tsx` test (terminal flows and `Ctrl+`` behaviour are unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/right-panel-layout.ts src/renderer/right-panel-layout.test.ts src/components/right-panel/files/files-pane.tsx src/components/right-panel/files/files-pane.test.tsx src/components/right-panel/tool-entries.tsx src/components/right-panel/tool-entries.test.tsx src/components/right-panel/terminal-tabs.tsx src/components/right-panel/terminal-tabs.test.tsx src/components/right-workspace.tsx src/components/right-workspace.test.tsx
git commit -m "feat(files): open the Files tool in the right panel

- enable Files in the tool list and + menu when a project is selected
- hold terminal and file tabs in one tab model, with a tree toggle on file tabs
- dock the tree beside the viewer in wide panels and open it over the viewer in narrow ones"
```

---

### Task 13: Verify in the running app

There is no code in this task unless something fails. It drives the real app to check what unit tests cannot, following the spec's Verification section.

**Files:** none, unless a defect is found. A fix gets its own failing test first, then its own `fix(files): …` commit.

- [ ] **Step 1: Start the app**

Run `pnpm start` in a terminal and wait for the window. Select a conversation in this repository (`fractal`) so `projectPath` is set.

- [ ] **Step 2: Walk the browse flow**

Open the right panel and choose Files. Check each of these:
- The panel shows a "Files" tab and the tree, with `node_modules`, `out` and `.vite` dimmed and no `.git`.
- Expanding `src` and clicking `App.tsx` fills the tab (italic title), and the viewer highlights TypeScript.
- Clicking `main.ts` replaces it.
- Double-clicking the tab turns the title upright.
- Typing `terminal` in the filter lists matching paths, and clearing it brings the tree back with `src` still expanded.

- [ ] **Step 3: Walk the live-update flow**

Open a Terminal tab beside the file tab and, from the project root, run each of these in turn, switching back to the file tab after each:

```bash
printf '\n// probe\n' >> src/App.tsx
```

The viewer shows the new last line without a reload.

```bash
cp src/App.tsx /tmp/app.bak && sed -i 's#// probe#// probe 2#' src/App.tsx
```

`sed -i` writes a temporary file and renames it over the original, so this checks the rename-over save. The viewer shows `// probe 2`.

```bash
mv src/App.tsx /tmp/App.moved.tsx
```

The viewer reads "This file no longer exists".

```bash
mv /tmp/App.moved.tsx src/App.tsx && git checkout -- src/App.tsx
```

The viewer recovers and shows the original file.

- [ ] **Step 4: Walk the narrow layout and the Open menu**

- Drag the panel narrower than 560px. The tree leaves the side, and the list-icon toggle opens it over the viewer; choosing a file closes it.
- In the Open menu, choose VS Code with a current line clicked. VS Code opens the file at that line, in the window that has this project open.
- Choose Zed. Zed opens it at the line, and the button now reads "Open in Zed" after an app restart.
- Choose "Show in folder". The file manager highlights the file, and the button still reads "Open in Zed".

- [ ] **Step 5: Record what could not be checked**

Cursor and Sublime Text aren't installed here, so their line syntax stays unverified. macOS detection is covered by unit tests only. Whether the tree width, the overlay, and the italic preview title feel right is left to human review. Report these in the end-of-run summary.

- [ ] **Step 6: Run the final checks**

Run: `pnpm test && pnpm lint && pnpm exec tsc --noEmit`
Expected: all pass. Confirm `git status` is clean apart from intended commits, and that `src/App.tsx` matches `HEAD`.
