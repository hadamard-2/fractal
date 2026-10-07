import { createHash } from 'node:crypto';
import { lstat as fsLstat, readFile as fsReadFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHANGES_COLLAPSE_LINES,
  CHANGES_FILE_MAX_BYTES,
  CHANGES_FILE_MAX_LINES,
  CHANGES_TOTAL_MAX_BYTES,
  type ChangeBody,
  type ChangedFile,
  type ChangesResult,
  type ChangeStatus,
  type DiffLine,
} from '@/shared/changes-contract';
import { FILE_VIEW_MAX_BYTES } from '@/shared/files-contract';
import { runGit, streamGitLines } from '@/main/git';
import { decodeText } from '@/main/text-file';
import { parseDiffRecords, parseStatus, type DiffRecord } from './git-records';
import { createPatchReader, type PatchLimits } from './patch-reader';

/** Filesystem calls, replaceable so tests can make files vanish mid-read. */
export interface ChangesDeps {
  lstat?: typeof fsLstat;
  readFile?: (path: string) => Promise<Uint8Array>;
  /** Runs between the raw/numstat diff and the patch diff. */
  betweenDiffs?: () => Promise<void>;
}

const DEFAULT_LIMITS: PatchLimits = {
  fileMaxLines: CHANGES_FILE_MAX_LINES,
  fileMaxBytes: CHANGES_FILE_MAX_BYTES,
  totalMaxBytes: CHANGES_TOTAL_MAX_BYTES,
};

// Matches the patch reader, which drops the leading backslash of git's marker.
const NO_NEWLINE = ' No newline at end of file';
const READ_ERROR: ChangesResult = { kind: 'error', message: "Changes couldn't be read" };

// Returned by a read whose two git diff calls saw different trees.
const RACED = Symbol('raced');

export async function readChanges(root: string, fingerprint?: string, limits: PatchLimits = DEFAULT_LIMITS, deps: ChangesDeps = {}): Promise<ChangesResult> {
  const resolved: Required<ChangesDeps> = {
    lstat: deps.lstat ?? fsLstat,
    readFile: deps.readFile ?? ((path) => fsReadFile(path)),
    betweenDiffs: deps.betweenDiffs ?? (() => Promise.resolve()),
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await read(root, fingerprint, limits, resolved);
      if (result !== RACED) return result;
    }
    return READ_ERROR;
  } catch {
    return READ_ERROR;
  }
}

async function read(root: string, previous: string | undefined, limits: PatchLimits, deps: Required<ChangesDeps>): Promise<ChangesResult | typeof RACED> {
  const prefixResult = await runGit(root, ['rev-parse', '--show-prefix']);
  if (prefixResult.code === null) return { kind: 'git-unavailable' };
  if (prefixResult.code === 128) return { kind: 'not-a-repo' };
  if (prefixResult.code !== 0) return READ_ERROR;

  const statusResult = await runGit(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', '.']);
  if (statusResult.code !== 0) return READ_ERROR;
  const status = parseStatus(statusResult.stdout, prefixResult.stdout.trim());

  const hash = createHash('sha256').update(statusResult.stdout);
  for (const path of status.paths) {
    try {
      const stats = await deps.lstat(join(root, path));
      hash.update(`\0${path}\0${stats.size}\0${stats.mtimeMs}`);
    } catch {
      hash.update(`\0${path}\0missing`);
    }
  }
  const nextFingerprint = hash.digest('hex');
  if (nextFingerprint === previous) return { kind: 'unchanged', fingerprint: nextFingerprint };

  let base = 'HEAD';
  if (status.head.commit === undefined) {
    const empty = await runGit(root, ['hash-object', '-t', 'tree', '--stdin'], '');
    if (empty.code !== 0) return READ_ERROR;
    base = empty.stdout.trim();
  }

  const diff = await runGit(root, ['diff', base, '--raw', '--numstat', '-z', '--no-abbrev', '--find-renames', '--relative']);
  if (diff.code !== 0) return READ_ERROR;
  const records = parseDiffRecords(diff.stdout);
  await deps.betweenDiffs();

  let bodies: ChangeBody[] = [];
  let truncated = false;
  let keptBytes = 0;
  if (records.length > 0) {
    const reader = createPatchReader(records, limits);
    const streamed = await streamGitLines(
      root,
      ['diff', base, '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--relative', '--unified=3'],
      reader.onLine,
    );
    if (streamed.code !== 0 && !streamed.stopped) return READ_ERROR;
    ({ bodies, truncated, bytes: keptBytes } = reader.finish());
  }

  if (records.some((record, index) => !agrees(record, bodies[index]))) return RACED;

  const files = new Map<string, ChangedFile>();
  for (const [index, record] of records.entries()) {
    const body = await withBinarySize(root, record, bodies[index], deps);
    const file = trackedFile(record, body, status.conflicted);
    const existing = files.get(file.path);
    if (existing === undefined || (existing.body.kind !== 'hunks' && file.body.kind === 'hunks')) files.set(file.path, file);
  }

  const budget: TotalBudget = { used: keptBytes, exhausted: truncated };
  for (const path of [...status.untracked].sort()) {
    const file = await untrackedFile(root, path, limits, budget, deps);
    if (file !== undefined && !files.has(file.path)) files.set(file.path, file);
  }

  const sorted = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { kind: 'changes', fingerprint: nextFingerprint, head: status.head, files: sorted, truncated: truncated || budget.exhausted };
}

/** Whether a record's numstat counts match the lines its patch body holds; bodies that are not hunks carry no counts to check. */
function agrees(record: DiffRecord, body: ChangeBody): boolean {
  if (body.kind !== 'hunks') return true;
  let added = 0;
  let removed = 0;
  for (const hunk of body.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'added') added++;
      else if (line.kind === 'removed') removed++;
    }
  }
  return added === record.added && removed === record.removed;
}

function collapsed(added: number | null, removed: number | null): boolean {
  return (added ?? 0) + (removed ?? 0) > CHANGES_COLLAPSE_LINES;
}

function trackedFile(record: DiffRecord, body: ChangeBody, conflicted: Set<string>): ChangedFile {
  let status: ChangeStatus;
  if (conflicted.has(record.path)) status = 'conflicted';
  else if (record.letter.startsWith('A')) status = 'added';
  else if (record.letter.startsWith('D')) status = 'deleted';
  else if (record.letter.startsWith('R')) status = 'renamed';
  else if (record.letter.startsWith('T')) status = 'type-changed';
  else status = 'modified';

  const file: ChangedFile = {
    path: record.path,
    status,
    added: record.added,
    removed: record.removed,
    collapsed: collapsed(record.added, record.removed),
    body,
  };
  if (record.oldPath !== undefined) file.oldPath = record.oldPath;
  return file;
}

async function withBinarySize(root: string, record: DiffRecord, body: ChangeBody, deps: Required<ChangesDeps>): Promise<ChangeBody> {
  if (body.kind !== 'binary') return body;
  try {
    if (record.letter.startsWith('D')) {
      const result = await runGit(root, ['cat-file', '-s', record.oldSha]);
      const size = Number(result.stdout.trim());
      return { kind: 'binary', size: result.code === 0 && Number.isSafeInteger(size) ? size : null };
    }
    return { kind: 'binary', size: (await deps.lstat(join(root, record.path))).size };
  } catch {
    return body;
  }
}

/** Bytes of diff kept so far in one read, shared by the tracked patch and untracked files. */
interface TotalBudget { used: number; exhausted: boolean }

async function untrackedFile(root: string, path: string, limits: PatchLimits, budget: TotalBudget, deps: Required<ChangesDeps>): Promise<ChangedFile | undefined> {
  if (path.endsWith('/')) {
    return { path: path.slice(0, -1), status: 'added', added: null, removed: null, collapsed: false, body: { kind: 'folder' } };
  }

  const entry = (body: ChangeBody, added: number | null): ChangedFile =>
    ({ path, status: 'added', added, removed: added === null ? null : 0, collapsed: collapsed(added, 0), body });

  try {
    const absolute = join(root, path);
    const stats = await deps.lstat(absolute);

    if ((stats.isSymbolicLink() || stats.isFile()) && budget.exhausted) return entry({ kind: 'not-loaded' }, null);

    if (stats.isSymbolicLink()) {
      return entry(hunkBody([{ kind: 'added', text: await readlink(absolute), newNumber: 1 }, { kind: 'no-newline', text: NO_NEWLINE }]), 1);
    }
    if (!stats.isFile()) return undefined;
    if (stats.size > FILE_VIEW_MAX_BYTES) return entry({ kind: 'too-large' }, null);

    const bytes = await deps.readFile(absolute);
    const text = decodeText(bytes);
    if (text === undefined) return entry({ kind: 'binary', size: bytes.length }, null);

    const rows = text.split('\n');
    const endsWithNewline = text.endsWith('\n') || text === '';
    if (endsWithNewline) rows.pop();
    const lines: DiffLine[] = rows.map((row, index) => ({
      kind: 'added',
      text: row.endsWith('\r') ? row.slice(0, -1) : row,
      newNumber: index + 1,
    }));
    if (rows.length > limits.fileMaxLines || bytes.length > limits.fileMaxBytes) return entry({ kind: 'too-large' }, rows.length);
    if (budget.used + bytes.length > limits.totalMaxBytes) {
      budget.exhausted = true;
      return entry({ kind: 'not-loaded' }, null);
    }
    budget.used += bytes.length;
    if (!endsWithNewline) lines.push({ kind: 'no-newline', text: NO_NEWLINE });
    return entry(hunkBody(lines), rows.length);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    return entry({ kind: 'not-loaded' }, null);
  }
}

function hunkBody(lines: DiffLine[]): ChangeBody {
  return { kind: 'hunks', hunks: lines.length === 0 ? [] : [{ header: '', oldStart: 0, newStart: 1, lines }] };
}
