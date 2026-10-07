// Shared Changes IPC contract, imported by main, preload, and renderer. No I/O.

export const CHANGES_CHANNELS = { invoke: 'fractal:changes:invoke' } as const;

/** Fractal's own bound; a starting value. */
export const CHANGES_POLL_MS = 2_000;
/** Fractal's own bound; a starting value. */
export const CHANGES_FILE_MAX_LINES = 5_000;
/** Fractal's own bound; a starting value. */
export const CHANGES_FILE_MAX_BYTES = 1024 * 1024;
/** Fractal's own bound; a starting value. */
export const CHANGES_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
/** Fractal's own bound; a starting value. */
export const CHANGES_COLLAPSE_LINES = 500;

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'type-changed' | 'conflicted';
export type EntryKind = 'file' | 'symlink' | 'submodule';
export interface DiffLine { kind: 'context' | 'added' | 'removed' | 'no-newline'; text: string; oldNumber?: number; newNumber?: number }
export interface DiffHunk { header: string; oldStart: number; newStart: number; lines: DiffLine[] }
export type ChangeBody =
  | { kind: 'hunks'; hunks: DiffHunk[] }
  | { kind: 'binary'; size: number | null }
  | { kind: 'too-large' }
  | { kind: 'mode'; oldMode: string; newMode: string }
  | { kind: 'type-change'; from: EntryKind; to: EntryKind }
  | { kind: 'submodule'; commit: string | null }
  | { kind: 'folder' }
  | { kind: 'not-loaded' };
export interface ChangedFile { path: string; oldPath?: string; status: ChangeStatus; added: number | null; removed: number | null; collapsed: boolean; body: ChangeBody }
export interface ChangesHead { branch?: string; commit?: string }
export type ChangesResult =
  | { kind: 'unchanged'; fingerprint: string }
  | { kind: 'changes'; fingerprint: string; head: ChangesHead; files: ChangedFile[]; truncated: boolean }
  | { kind: 'not-a-repo' }
  | { kind: 'git-unavailable' }
  | { kind: 'error'; message: string };
export type ChangesRequest = { method: 'read'; root: string; fingerprint?: string };
export interface ChangesApi { read(root: string, fingerprint?: string): Promise<ChangesResult> }

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
const absolutePath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 32_768 &&
  (value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value));
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const has = (value: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

export function parseChangesRequest(value: unknown): ChangesRequest {
  if (object(value) && value.method === 'read' && absolutePath(value.root) && keys(value, ['method', 'root', 'fingerprint'])) {
    if (!has(value, 'fingerprint')) return { method: 'read', root: value.root };
    if (id(value.fingerprint)) return { method: 'read', root: value.root, fingerprint: value.fingerprint };
  }
  throw new Error('Invalid changes request');
}
