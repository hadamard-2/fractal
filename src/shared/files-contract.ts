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
      return { method: 'listDirectory', root: value.root, path: value.path };
    }
    if (method === 'readFile' && absolutePath(value.root) && filePath(value.path) && keys(value, ['method', 'root', 'path'])) {
      return { method: 'readFile', root: value.root, path: value.path };
    }
    if (method === 'listFiles' && absolutePath(value.root) && keys(value, ['method', 'root'])) {
      return { method: 'listFiles', root: value.root };
    }
    if (method === 'watch' && id(value.watchId) && absolutePath(value.root) && relativePath(value.path) && keys(value, ['method', 'watchId', 'root', 'path'])) {
      return { method: 'watch', watchId: value.watchId, root: value.root, path: value.path };
    }
    if (method === 'unwatch' && id(value.watchId) && keys(value, ['method', 'watchId'])) {
      return { method: 'unwatch', watchId: value.watchId };
    }
    if (method === 'editors' && keys(value, ['method'])) return { method: 'editors' };
    if (method === 'open' && typeof value.action === 'string' && ACTIONS.includes(value.action) && absolutePath(value.root) &&
      filePath(value.path) && line(value.line) && keys(value, ['method', 'action', 'root', 'path', 'line'])) {
      return { method: 'open', action: value.action as OpenAction, root: value.root, path: value.path, ...(value.line === undefined ? {} : { line: value.line }) };
    }
  }
  throw new Error('Invalid files request');
}

export function parseFilesEvent(value: unknown): FilesEvent {
  if (object(value) && value.type === 'changed' && id(value.watchId)) return { type: 'changed', watchId: value.watchId };
  throw new Error('Invalid files event');
}
