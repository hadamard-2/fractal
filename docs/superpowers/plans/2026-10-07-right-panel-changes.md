# Right panel Changes tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the right panel's placeholder "Review" entry into a working, read-only **Changes** tool that shows the project's uncommitted changes against `HEAD` as one live-updating stream of unified diffs.

**Architecture:** Main runs read-only git commands (`status`, `diff --raw --numstat`, `diff` patch), parses them into a typed `ChangesResult`, and serves it over one validated invoke channel, guarded by the same known-project check Files uses. The renderer polls that channel every 2 s while a Changes tab is selected and the window is visible, passing a fingerprint so an unchanged tree costs almost nothing. A pure row model flattens files into virtualised rows for the stream.

**Tech Stack:** Electron 43 IPC + contextBridge, Node `child_process`, React 19, `@tanstack/react-virtual`, `@streamdown/code`, lucide-react, shadcn/ui, Vitest + Testing Library.

**Spec:** [docs/superpowers/specs/2026-10-07-right-panel-changes-design.md](../specs/2026-10-07-right-panel-changes-design.md)

## Global Constraints

- Nothing in this feature writes to the repository: no `git add`, no `add -N`, no `hash-object -w`, no `update-index`. Every git call is `spawn('git', ['-C', cwd, ...], { shell: false })` with `GIT_OPTIONAL_LOCKS=0` in its environment.
- Starting values, in `src/shared/changes-contract.ts`: `CHANGES_POLL_MS = 2_000`, `CHANGES_FILE_MAX_LINES = 5_000`, `CHANGES_FILE_MAX_BYTES = 1024 * 1024`, `CHANGES_TOTAL_MAX_BYTES = 8 * 1024 * 1024`, `CHANGES_COLLAPSE_LINES = 500`. Reused from Files: `FILE_VIEW_MAX_BYTES`, `FILE_HIGHLIGHT_MAX_BYTES`.
- Copy is exact: "Changes", "Ctrl+Shift+G", "Open a project first", "N files changed · +X −Y" (singular "1 file changed"), "Checked Ns ago", "No uncommitted changes", "Not a git repository", "Git isn't available", "Changes couldn't be read", "Retry", "Binary file changed · 1.2 MiB", "Diff too large to show · +X −Y", "Not loaded: too many changes", "File mode changed 644 → 755", "Changed from a file to a symlink", "Submodule moved to `abc1234`", "Submodule has uncommitted changes", "Untracked folder · contents not shown", "Conflicted", "Open in Files". The minus sign in counts is U+2212 `−`.
- The renderer reaches git only through `window.fractal.changes`; `contextIsolation` and `nodeIntegration` stay as they are.
- Tooltips use `components/ui/tooltip.tsx`, never a `title` attribute. No per-element scrollbar styling; never set `scrollbar-width` or `scrollbar-color`.
- Only fixed reason strings cross IPC; git's stderr and filesystem errors stay in main.
- Before any task is called done: `pnpm test`, `pnpm lint`, `pnpm exec tsc --noEmit`.
- Markdown files are never hard-wrapped.

## Review Focus

- **Project is a folder inside a larger repository (monorepo).** Expect only that folder's changes, with paths relative to the project, never files from sibling folders. Pinned in Task 5.
- **The user's git config reshapes diff output** (`diff.suppressBlankEmpty`, `diff.noprefix`, `diff.mnemonicPrefix`, `color.ui=always`, `diff.context=10`, `diff.external`). Expect the same parse as with no config. Pinned in Task 4 (blank context line) and Task 5 (repo config).
- **An agent is running git at the same time** (`.git/index.lock` exists, or a rebase is in progress). Expect the read to succeed, and no lock or other file to be created by Fractal. Pinned in Task 5.
- **The tree changes during a read** (an untracked file deleted between `status` and reading it, an untracked symlink, an untracked nested repository). Expect no crash: a vanished file is simply absent, a symlink shows its target, and a nested repo is a "folder" entry. Pinned in Task 5.
- **The panel moves on while a read is in flight** (tab deselected, tab closed, or the hook's root changes). Expect no state update after unmount and no result from one project shown for another. Pinned in Task 7.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/main/git.ts` (new, moved from `files/git.ts`) | `gitEnvironment`, `runGit`, and the new line-streaming `streamGitLines` |
| `src/main/project-roots.ts` (new) | `UnknownProjectError` and `createRootCheck`, shared by the files and changes IPC |
| `src/main/files/git.ts` | Keeps `ignoredNames` and `listGitFiles`, now importing from `@/main/git` |
| `src/main/files/files-ipc.ts` | Uses `createRootCheck` instead of its own copy |
| `src/shared/changes-contract.ts` (new) | Channel, constants, result types, `ChangesApi`, `parseChangesRequest` |
| `src/main/changes/git-records.ts` (new) | Pure parsers for porcelain v2 status and `--raw --numstat -z` output |
| `src/main/changes/patch-reader.ts` (new) | Pure line-by-line patch parser that matches sections to records and applies the caps |
| `src/main/changes/changes-service.ts` (new) | `readChanges`: runs git, fingerprints, reads untracked files, and assembles `ChangesResult` |
| `src/main/changes/changes-ipc.ts` (new) | `registerChangesIpc`: sender check, request validation, root check |
| `src/preload.ts`, `src/global.d.ts`, `src/main.ts` | Expose and wire `window.fractal.changes` |
| `src/renderer/use-changes.ts` (new) | Polling hook |
| `src/renderer/changes-rows.ts` (new) | Pure row model, body messages, open-at lines, summary text |
| `src/renderer/diff-highlight.ts` (new) | `useDiffHighlights`: lazy per-file, per-side highlighting of visible files |
| `src/components/right-panel/changes/changes-pane.tsx` (new) | Whole states, summary header, file list |
| `src/components/right-panel/changes/diff-stream.tsx` (new) | Virtualised stream, file headers (sticky overlay), lines, actions |
| `src/renderer/panel-tabs.ts`, `src/components/right-panel/panel-tabs.tsx`, `src/components/right-panel/tool-entries.tsx`, `src/components/right-workspace.tsx` | The `changes` tab kind, the entry, Ctrl+Shift+G, rendering the pane |

---

### Task 1: Shared git runner and root check

A move with no behaviour change, plus one new primitive: a line-streaming git reader that can be stopped early.

**Files:**
- Create: `src/main/git.ts`, `src/main/git.test.ts`, `src/main/project-roots.ts`, `src/main/project-roots.test.ts`
- Modify: `src/main/files/git.ts`, `src/main/files/files-ipc.ts`

**Interfaces:**
- Produces:
  - `gitEnvironment(): NodeJS.ProcessEnv` (process env + `GIT_OPTIONAL_LOCKS: '0'`, read at call time)
  - `runGit(cwd: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string }>`, moved unchanged
  - `streamGitLines(cwd: string, args: string[], onLine: (line: string) => boolean): Promise<{ code: number | null; stopped: boolean }>`. It splits stdout on `\n` only, keeping any `\r`, and delivers a final unterminated line at close. When `onLine` returns `false` it stops delivering, kills the child, and resolves `stopped: true`. A git that cannot start resolves `{ code: null, stopped: false }`.
  - `class UnknownProjectError extends Error` (`name = 'UnknownProjectError'`)
  - `createRootCheck(knowsProject: (projectPath: string) => Promise<boolean>): (root: string) => Promise<void>` throws `UnknownProjectError('Unknown project')` for an unknown root and caches known roots, exactly as `files-ipc.ts` does today.

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/git.test.ts — temp repo via execFileSync('git', ['init', ...]) as files/git.test.ts does
test('streams lines, including a final line without a newline', async () => {
  const lines: string[] = [];
  const result = await streamGitLines(root, ['show', 'HEAD:three.txt'], (line) => { lines.push(line); return true; });
  expect(result).toEqual({ code: 0, stopped: false });
  expect(lines).toEqual(['a', 'b\r', 'c']); // file content 'a\nb\r\nc'
});
test('stops when the consumer returns false', async () => {
  const lines: string[] = [];
  const result = await streamGitLines(root, ['show', 'HEAD:three.txt'], (line) => { lines.push(line); return false; });
  expect(result.stopped).toBe(true);
  expect(lines).toEqual(['a']);
});
test('reports a git that cannot start', async () => {
  vi.stubEnv('PATH', '');
  expect(await streamGitLines(root, ['status'], () => true)).toEqual({ code: null, stopped: false });
});

// src/main/project-roots.test.ts
test('refuses unknown roots and asks about a known root only once', async () => {
  const knowsProject = vi.fn(async (path: string) => path === '/known');
  const check = createRootCheck(knowsProject);
  await expect(check('/other')).rejects.toBeInstanceOf(UnknownProjectError);
  await check('/known'); await check('/known');
  expect(knowsProject.mock.calls.filter(([path]) => path === '/known')).toHaveLength(1);
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm test src/main/git.test.ts src/main/project-roots.test.ts`. Expected: FAIL, modules not found.

- [ ] **Step 3: Implement.** Move `runGit` and the environment helper into `src/main/git.ts` and export them. Add `streamGitLines`, built like `listGitFiles` (`setEncoding('utf8')`, carry the partial tail between chunks). Create `project-roots.ts`. Point `files/git.ts` at `@/main/git`. In `files-ipc.ts`, replace the local `UnknownProjectError`, `knownRoots`, and `checkRoot` with `const checkRoot = createRootCheck(deps.knowsProject)`, keeping the `instanceof UnknownProjectError` mapping.

- [ ] **Step 4: Run the new tests and the existing Files tests.** Run `pnpm test src/main`. Expected: PASS, including the unchanged `files/*.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/main/git.ts src/main/git.test.ts src/main/project-roots.ts src/main/project-roots.test.ts src/main/files/git.ts src/main/files/files-ipc.ts
git commit -m "refactor(main): share the git runner and project root check"
```

---

### Task 2: Changes contract

**Files:**
- Create: `src/shared/changes-contract.ts`, `src/shared/changes-contract.test.ts`

**Interfaces:**
- Produces (all exported):

```ts
export const CHANGES_CHANNELS = { invoke: 'fractal:changes:invoke' } as const;
// + the five constants in Global Constraints, each with a one-line "Fractal's own bound; a starting value" doc comment

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
  | { kind: 'submodule'; commit: string | null } // null: only uncommitted changes inside it
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
export function parseChangesRequest(value: unknown): ChangesRequest;
```

- [ ] **Step 1: Write the failing test.** `parseChangesRequest` accepts `{ method: 'read', root: '/repo' }` and `{ method: 'read', root: '/repo', fingerprint: 'abc' }`. It throws `'Invalid changes request'` for a relative root, a missing root, an unknown method, an extra key, a non-string or empty fingerprint, a fingerprint over 128 characters, and a non-plain object (an array, or `Object.create({})`).
- [ ] **Step 2: Run it and confirm it fails.** Run `pnpm test src/shared/changes-contract.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it** with hand-written guards in the style of `files-contract.ts` (copy its `object`, `absolutePath`, and `keys` helpers; do not import zod).
- [ ] **Step 4: Run it and confirm it passes.** Run `pnpm test src/shared/changes-contract.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(changes): add the Changes IPC contract"`

---

### Task 3: Status and diff-record parsers

These are pure functions over git's `-z` output. Facts below were verified against git 2.53: porcelain v2 paths are relative to the repository's top level even with `-- .`; `branch.oid` is `(initial)` before the first commit and `branch.head` is `(detached)` when detached; an untracked nested repository is listed as `? dir/`; in `--raw --numstat -z` output all raw records come first, then all numstat records in the same order; a numstat rename is `added\tremoved\t\0old\0new\0`; a binary numstat is `-\t-\t`.

**Files:**
- Create: `src/main/changes/git-records.ts`, `src/main/changes/git-records.test.ts`

**Interfaces:**
- Consumes: `ChangesHead`, `EntryKind` from Task 2.
- Produces:

```ts
export interface StatusRecords {
  head: ChangesHead;
  /** Every path status lists inside the project, rename sources included, project-relative. Used for the fingerprint. */
  paths: string[];
  /** Project-relative; a nested repository keeps its trailing '/'. */
  untracked: string[];
  conflicted: Set<string>;
}
export function parseStatus(output: string, prefix: string): StatusRecords;

export interface DiffRecord {
  path: string; oldPath?: string;
  letter: string;            // raw status letter without score: 'A' | 'D' | 'M' | 'R' | 'T' | 'U' | 'C' …
  oldMode: string; newMode: string;  // six octal digits, '000000' when absent
  oldSha: string;            // full, from --no-abbrev
  added: number | null; removed: number | null;  // null for binary
}
export function parseDiffRecords(output: string): DiffRecord[];
export function entryKind(mode: string): EntryKind;  // '120000' symlink, '160000' submodule, else file
```

`parseStatus` drops any entry whose path does not start with `prefix` (defensive), and strips `prefix` from paths, rename sources, and untracked entries. Field counts before the path: `1` has 8 fields, `2` has 9 fields and is followed by an origPath token, `u` has 10 fields. A path may contain spaces, so split the fixed fields off and keep the rest.

- [ ] **Step 1: Write the failing tests** using NUL-joined fixture strings, built as `['# branch.oid …', '1 .M N... …', …].join('\0') + '\0'`.

```ts
test('reads head, changed, renamed, conflicted and untracked entries', () => {
  const records = parseStatus(STATUS, '');
  expect(records.head).toEqual({ branch: 'main', commit: '48ca86f8c49f2f4db36ad71059fd7e768f680c63' });
  expect(records.untracked).toEqual(['untracked.txt', 'nested/']);
  expect(records.conflicted).toEqual(new Set(['both.txt']));
  expect(records.paths).toEqual(expect.arrayContaining(['with space.txt', 'renamed.txt', 'ren.txt', 'both.txt', 'untracked.txt', 'nested/']));
});
test('reports no commit before the first one and no branch when detached', () => {
  expect(parseStatus('# branch.oid (initial)\0# branch.head main\0', '').head).toEqual({ branch: 'main' });
  expect(parseStatus('# branch.oid abc\0# branch.head (detached)\0', '').head).toEqual({ commit: 'abc' });
});
test('strips the project folder prefix and drops entries outside it', () => {
  const records = parseStatus('1 .M N... 100644 100644 100644 a a app/a\0' + '1 .M N... 100644 100644 100644 b b other/o\0' + '? app/new\0', 'app/');
  expect(records.paths).toEqual(['a', 'new']);
  expect(records.untracked).toEqual(['new']);
});
test('pairs raw and numstat records, including renames, binaries and odd names', () => {
  expect(parseDiffRecords(RAW_NUMSTAT)).toEqual([
    { path: 'bin.dat', letter: 'M', oldMode: '100644', newMode: '100644', oldSha: BIN_SHA, added: null, removed: null },
    { path: 'mode.sh', letter: 'M', oldMode: '100644', newMode: '100755', oldSha: MODE_SHA, added: 0, removed: 0 },
    { path: 'renamed.txt', oldPath: 'ren.txt', letter: 'R', oldMode: '100644', newMode: '100644', oldSha: REN_SHA, added: 1, removed: 1 },
    { path: 'tc.txt', letter: 'T', oldMode: '100644', newMode: '120000', oldSha: TC_SHA, added: 1, removed: 1 },
    { path: 'line\nbreak.txt', letter: 'M', oldMode: '100644', newMode: '100644', oldSha: LB_SHA, added: 2, removed: 0 },
  ]);
});
test('names entry kinds by mode', () => {
  expect([entryKind('100644'), entryKind('100755'), entryKind('120000'), entryKind('160000')]).toEqual(['file', 'file', 'symlink', 'submodule']);
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm test src/main/changes/git-records.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `parseStatus`, `parseDiffRecords`, and `entryKind`.** A raw record is `:oldMode newMode oldSha newSha LETTER[score]`, then one path token, or two for `R` and `C` (old, then new).
- [ ] **Step 4: Run them and confirm they pass.** Run `pnpm test src/main/changes/git-records.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(changes): parse git status and diff records"`

---

### Task 4: Patch reader

This is a pure, streaming parser. Patch sections appear in the same order as the diff records. A record with letter `T` takes **two** sections (verified: git prints the old entry deleted, then the new one added). File paths are never read from patch headers; the `---`/`+++` lines of a name with spaces carry a trailing tab, for example.

**Files:**
- Create: `src/main/changes/patch-reader.ts`, `src/main/changes/patch-reader.test.ts`

**Interfaces:**
- Consumes: `DiffRecord`, `entryKind` (Task 3); `ChangeBody`, `DiffHunk`, `DiffLine`, and the caps (Task 2).
- Produces:

```ts
export interface PatchLimits { fileMaxLines: number; fileMaxBytes: number; totalMaxBytes: number }
export interface PatchOutcome { bodies: ChangeBody[]; truncated: boolean }  // bodies[i] belongs to records[i]
export function createPatchReader(records: DiffRecord[], limits?: PatchLimits): { onLine(line: string): boolean; finish(): PatchOutcome };
```

Rules, applied per record:

1. A line starting `diff --git ` starts the next section. The lines before a section's first `@@` are headers and are ignored.
2. `@@ -a[,b] +c[,d] @@ context` starts a hunk: `header` is the text after the second `@@`, trimmed (`''` when there is none), and line numbers count up from `a` and `c`.
3. Inside a hunk, a line starting `+` is added (`newNumber`), `-` is removed (`oldNumber`), `\` is `no-newline` (no numbers), and `' '` or an **empty line** is context (both numbers). The empty line is what `diff.suppressBlankEmpty` produces. Drop the prefix character and one trailing `\r`.
4. A record's body is decided in this order:
   - `letter === 'T'` gives `type-change` from `entryKind(oldMode)` to `entryKind(newMode)`.
   - Either mode `160000` gives `submodule`, with `commit` from the section's `+Subproject commit <sha>[-dirty]` line. It is null when that sha equals the `-Subproject commit` sha.
   - `added === null` gives `{ kind: 'binary', size: null }`, which the service fills in.
   - `added + removed > fileMaxLines` gives `too-large`, decided before reading and without storing lines.
   - A section with no hunks and `oldMode !== newMode` gives `mode`.
   - Otherwise `hunks`. While reading, a section whose stored line count exceeds `fileMaxLines` or whose bytes (`line.length + 1` per line) exceed `fileMaxBytes` becomes `too-large`, and its stored lines are discarded.
5. Only bytes of sections that end as `hunks` count toward the total. When a section would take the total past `totalMaxBytes`, that record and every later one become `not-loaded`, `truncated` is set, and `onLine` returns `false`.
6. Records the patch never reached when `finish()` is called (the stream was stopped) are `not-loaded`.

- [ ] **Step 1: Write the failing tests.** Feed with `const feed = (patch: string) => patch.split('\n').slice(0, -1).every(reader.onLine)`, using the patch printed during planning in the probe repository (bin.dat, del.txt, mod.txt, mode.sh, nonl.txt, ren→renamed, staged.txt, tc.txt twice, `with space.txt`) as the fixture, with its matching records.

```ts
test('parses hunks with numbers, function context, and missing newlines', () => {
  const { bodies } = read(RECORDS, PATCH);
  expect(bodyFor('mod.txt')).toEqual({ kind: 'hunks', hunks: [{ header: '', oldStart: 1, newStart: 1, lines: [
    { kind: 'context', text: 'one', oldNumber: 1, newNumber: 1 },
    { kind: 'removed', text: 'two', oldNumber: 2 },
    { kind: 'added', text: 'TWO', newNumber: 2 },
    { kind: 'context', text: 'three', oldNumber: 3, newNumber: 3 },
  ] }] });
  expect(bodyFor('renamed.txt').hunks[0].header).toBe('b');
  expect(bodyFor('nonl.txt').hunks[0].lines.map((line) => line.kind)).toEqual(['removed', 'no-newline', 'added', 'no-newline']);
});
test('matches sections to records, giving a type change two sections', () => {
  expect(bodyFor('tc.txt')).toEqual({ kind: 'type-change', from: 'file', to: 'symlink' });
  expect(bodyFor('with space.txt').kind).toBe('hunks'); // the record after the type change still gets its own section
  expect(bodyFor('bin.dat')).toEqual({ kind: 'binary', size: null });
  expect(bodyFor('mode.sh')).toEqual({ kind: 'mode', oldMode: '100644', newMode: '100755' });
});
test('reads submodule moves and uncommitted submodule changes', () => { /* +Subproject commit 1ec00a6… vs 333b2a1… → commit '1ec00a6…'; same sha with -dirty → null */ });
test('treats an empty line inside a hunk as context, and strips CR', () => {
  // '@@ -1,3 +1,3 @@\n x\n\n-y\r\n+Y\r\n'
  expect(lines.map(({ kind, text }) => [kind, text])).toEqual([['context', 'x'], ['context', ''], ['removed', 'y'], ['added', 'Y']]);
});
test('applies the per-file caps', () => {
  // limits { fileMaxLines: 3, fileMaxBytes: 1_000, totalMaxBytes: 10_000 }: a record with numstat 4+0 → too-large and its lines are not stored;
  // limits { fileMaxLines: 100, fileMaxBytes: 10, … }: a 20-byte section → too-large
});
test('stops at the total cap, marking the rest not loaded', () => {
  // three 40-byte sections, totalMaxBytes 100 → bodies [hunks, hunks, not-loaded], truncated true, and onLine returned false
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm test src/main/changes/patch-reader.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `createPatchReader`**, defaulting `limits` to the contract's `CHANGES_FILE_MAX_LINES`, `CHANGES_FILE_MAX_BYTES`, and `CHANGES_TOTAL_MAX_BYTES`.
- [ ] **Step 4: Run them and confirm they pass.** Run `pnpm test src/main/changes/patch-reader.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(changes): parse diff patches into hunks within bounds"`

---

### Task 5: Changes service

**Files:**
- Create: `src/main/changes/changes-service.ts`, `src/main/changes/changes-service.test.ts`

**Interfaces:**
- Consumes: `runGit` and `streamGitLines` (Task 1); `parseStatus`, `parseDiffRecords` (Task 3); `createPatchReader` (Task 4); `decodeText` from `@/main/text-file`; `FILE_VIEW_MAX_BYTES` from `@/shared/files-contract`.
- Produces: `readChanges(root: string, fingerprint?: string, limits?: PatchLimits): Promise<ChangesResult>`. It never throws for git or filesystem failures; it returns `{ kind: 'error', message: "Changes couldn't be read" }` instead.

Sequence:

1. `git rev-parse --show-prefix`. A null code gives `git-unavailable`; exit 128 gives `not-a-repo`; the trimmed stdout is the prefix.
2. `git status --porcelain=v2 -z --branch --untracked-files=all -- .` → `parseStatus(stdout, prefix)`.
3. The fingerprint is the SHA-256 hex of the status stdout, followed by `\0path\0size\0mtimeMs` for each of `paths`, from `lstat(join(root, path))`, or `\0path\0missing` when `lstat` fails. If it equals `fingerprint`, return `unchanged`.
4. Base: `'HEAD'` when `head.commit` is set; otherwise the trimmed stdout of `git hash-object -t tree --stdin` with empty input.
5. `git diff <base> --raw --numstat -z --no-abbrev --find-renames --relative` → `parseDiffRecords`.
6. `streamGitLines(root, ['diff', base, '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--relative', '--unified=3'], reader.onLine)`, then `reader.finish()`.
7. Binary sizes: from `lstat` of the working file, or for a deleted file `git cat-file -s <oldSha>`. A size that cannot be read stays null.
8. Untracked entries:
   - a path ending in `/` gives `{ kind: 'folder' }` with null counts;
   - a symlink gives one added line holding its target, followed by a `no-newline` row;
   - a file larger than `FILE_VIEW_MAX_BYTES` gives `too-large` with null counts, without being read;
   - otherwise the file is read: `decodeText` undefined gives `binary` with its size, and text gives one all-added hunk (`oldStart: 0, newStart: 1`, plus a `no-newline` row when the file does not end in `\n`), or `too-large` when it is over either per-file cap;
   - a file that has vanished since status is left out.
9. Status: the letter `A`/`D`/`R`/`T` maps to added/deleted/renamed/type-changed, everything else to modified; untracked is added; a path in `conflicted` is `conflicted`, whatever the letter. `collapsed` is `(added ?? 0) + (removed ?? 0) > CHANGES_COLLAPSE_LINES`. Sort all files by `path` with plain `<` comparison. `truncated` comes from the patch outcome.

- [ ] **Step 1: Write the failing tests** against real temporary repositories (`mkdtemp` + `realpath`, `git init -q`, local `user.name`/`user.email`, commits via `execFileSync`).

```ts
test('a clean repository has no changes; a folder that is not a repository says so', …);           // files: [] ; { kind: 'not-a-repo' }
test('reports git as unavailable when it cannot start', …);                                           // vi.stubEnv('PATH', '') → { kind: 'git-unavailable' }
test('names each kind of change', …);  // modified, staged-added, deleted, renamed+modified (oldPath), untracked, mode-only, file→symlink, binary (size = bytes on disk), deleted binary (size from cat-file)
test('marks a conflicted file and shows its conflict markers as additions', …);  // status 'conflicted'; lines include { kind: 'added', text: '<<<<<<< HEAD' }
test('reports a submodule move', …);           // git -c protocol.file.allow=always submodule add; commit inside → { kind: 'submodule', commit: <full sha> }
test('diffs against the empty tree before the first commit', …);                 // staged file → added hunks; head = { branch: 'main' }
test('keeps unusual names intact', …);          // 'with space.txt', 'ünï.txt', 'line\nbreak.txt' all appear with exact paths
test('returns unchanged for an unchanged tree, and a new fingerprint after each kind of edit', …);  // re-edit a modified file; add an untracked file; commit
test('applies the size bounds', …);             // limits { fileMaxLines: 10, fileMaxBytes: 1_000_000, totalMaxBytes: 1_000_000 } → 11-line change too-large; 600-line change collapsed with default limits; small totalMaxBytes → later files not-loaded, truncated
// Review Focus
test('shows only the project folder of a larger repository, relative to it', …);      // root = repo/app: files ['a', 'new'], nothing from repo/other
test('parses the same with diff-reshaping git config', …);  // git config diff.suppressBlankEmpty true, diff.noprefix true, diff.mnemonicPrefix true, color.ui always, diff.context 10, diff.external false → result equals the unconfigured repository's
test('reads while another git holds the index lock, and creates nothing', …);   // touch .git/index.lock; read succeeds; afterwards the .git listing (names, and index mtime and bytes) is identical
test('tolerates untracked entries that vanish, link, or nest', …);   // symlink → added line with its target; nested repo → { kind: 'folder' } at 'nested/'; a file deleted between status and read via an injected hook, or by deleting it in a status spy, is absent
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm test src/main/changes/changes-service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `readChanges`** following the sequence above. For the vanishing-file test, the service may take an optional `deps: { lstat?, readFile? }` parameter after `limits`; keep it internal to tests.
- [ ] **Step 4: Run them and confirm they pass.** Run `pnpm test src/main/changes`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(changes): read uncommitted changes from git"`

---

### Task 6: IPC, preload, and main wiring

**Files:**
- Create: `src/main/changes/changes-ipc.ts`, `src/main/changes/changes-ipc.test.ts`
- Modify: `src/preload.ts`, `src/global.d.ts`, `src/main.ts`

**Interfaces:**
- Consumes: `createRootCheck`, `UnknownProjectError` (Task 1); `parseChangesRequest`, `CHANGES_CHANNELS`, `ChangesApi`, `ChangesResult` (Task 2); `readChanges` (Task 5); `createOwnerTracker` from `@/main/ipc-owners`.
- Produces:
  - `registerChangesIpc(deps: { knowsProject(projectPath: string): Promise<boolean>; read?: typeof readChanges }, getWindow: () => BrowserWindow | null): { dispose(): void }`
  - `window.fractal.changes: ChangesApi`. Preload sends `{ method: 'read', root, ...(fingerprint === undefined ? {} : { fingerprint }) }`.

The handler authorizes the sender (`createOwnerTracker(getWindow, () => undefined, 'Unauthorized changes sender')`), parses the request, checks the root, and returns `read(root, fingerprint)`. An `UnknownProjectError` is thrown as `new Error('Unknown project')`. Any other throw is returned as `{ kind: 'error', message: "Changes couldn't be read" }`.

- [ ] **Step 1: Write the failing tests**, mocking `electron` as `files-ipc.test.ts` does: a call from the window's main frame with a known root returns the stubbed `read` result and passes the fingerprint through; a foreign sender is refused with `'Unauthorized changes sender'`; an unknown root rejects with `'Unknown project'`; an invalid payload rejects; a `read` that throws resolves to the fixed error result; `dispose` removes the handler.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm test src/main/changes/changes-ipc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement and wire it.** Add `changes` to preload's `exposeInMainWorld` and to `global.d.ts`. In `main.ts`, register beside `registerFilesIpc`, using the same `knowsProject` lambda, keep the registration in a module variable, and dispose it wherever `filesRegistration` is disposed.
- [ ] **Step 4: Run the tests and the typecheck.** Run `pnpm test src/main/changes && pnpm exec tsc --noEmit`. Expected: PASS, with no type errors.
- [ ] **Step 5: Commit.** `git commit -m "feat(changes): expose Changes reads to the renderer"`

---

### Task 7: Polling hook

**Files:**
- Create: `src/renderer/use-changes.ts`, `src/renderer/use-changes.test.tsx` (`// @vitest-environment jsdom`)

**Interfaces:**
- Consumes: `window.fractal.changes.read`, `ChangesResult`, `CHANGES_POLL_MS` (Task 2).
- Produces:

```ts
export type ChangesSnapshot = Extract<ChangesResult, { kind: 'changes' | 'not-a-repo' | 'git-unavailable' }>;
export interface ChangesView {
  snapshot: ChangesSnapshot | null;  // last good result; null until the first one
  failed: boolean;                   // the latest read failed (an error result or a rejection)
  checkedAt: number | null;          // Date.now() when the latest successful read resolved
  refresh(): void;
}
export function useChanges(root: string, active: boolean): ChangesView;
```

The hook reads when `active` turns true, then every `CHANGES_POLL_MS` while `active && document.visibilityState === 'visible'`. It also reads at once on `visibilitychange` to visible and on window `focus` while active, and on `refresh()`. It sends the latest snapshot's fingerprint; `unchanged` only updates `checkedAt`. At most one read is in flight: a tick during a read is dropped, and a `refresh()` during a read runs once that read settles. When `root` changes, the snapshot is cleared, and responses for the old root are ignored.

- [ ] **Step 1: Write the failing tests** with `vi.useFakeTimers()`, a stubbed `window.fractal.changes.read`, and `renderHook`:

```ts
test('reads on activation and every 2 s while active and visible', …);       // 1 call at mount; +1 after 2000 ms; none while active=false; none while visibilityState 'hidden'
test('sends the last fingerprint and keeps the snapshot on unchanged', …);   // second call receives 'fp1'; snapshot identity unchanged; checkedAt advances
test('never overlaps reads, and runs a refresh requested mid-read afterwards', …);  // pending promise: advancing 6000 ms → still 1 call; refresh() → still 1; resolve → 2
test('keeps the last good snapshot when a read fails', …);  // error result then rejection → snapshot kept, failed true; next success → failed false
// Review Focus
test('ignores a late response for a previous root and never updates after unmount', …);  // rerender root '/b' before '/a' resolves → snapshot stays null until '/b' answers; unmount then resolve → no React act() warning
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm test src/renderer/use-changes.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement `useChanges`.**
- [ ] **Step 4: Run them and confirm they pass.** Run `pnpm test src/renderer/use-changes.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(changes): poll for changes while the tool is visible"`

---

### Task 8: Row model

**Files:**
- Create: `src/renderer/changes-rows.ts`, `src/renderer/changes-rows.test.ts`

**Interfaces:**
- Consumes: `ChangedFile`, `DiffLine` (Task 2); `formatSize` from `@/renderer/file-display`.
- Produces:

```ts
export type ChangeRow =
  | { kind: 'file'; key: string; fileIndex: number }
  | { kind: 'hunk'; key: string; fileIndex: number; header: string }
  | { kind: 'line'; key: string; fileIndex: number; line: DiffLine; side: 'old' | 'new'; sideIndex: number; openAt: number }
  | { kind: 'message'; key: string; fileIndex: number; text: string };
export const FILE_ROW_HEIGHT = 36;
export const LINE_ROW_HEIGHT = 20;   // hunk, line, and message rows
export function isCollapsed(file: ChangedFile, overrides: ReadonlyMap<string, boolean>): boolean;
export function buildRows(files: ChangedFile[], overrides: ReadonlyMap<string, boolean>): ChangeRow[];
export function bodyMessage(file: ChangedFile): string | null;  // null for 'hunks'
export function summaryText(files: ChangedFile[]): string;      // "3 files changed · +12 −4"
export function countsText(added: number | null, removed: number | null): string;  // "+12 −4"; '' when both null
export function statusLetter(status: ChangeStatus): 'M' | 'A' | 'D' | 'R' | 'T' | 'U';
export function fileIndexAt(rows: ChangeRow[], index: number): number;
```

`buildRows` emits a `file` row for every file. A collapsed file gets nothing more. Otherwise it gets a `message` row from `bodyMessage`, or, for each hunk, a `hunk` row followed by its `line` rows. The keys are stable across refreshes and are what the scroll anchor uses: `f:${path}`; `h:${path}:${oldStart}:${newStart}`; `l:${path}:${kind}:${oldNumber ?? ''}:${newNumber ?? ''}`, plus `:${n}` for `no-newline` rows; `m:${path}`.

For a line row, `side` is `'old'` for removed lines and `'new'` otherwise. `sideIndex` is the line's position in the file's old-side text (context and removed lines) or new-side text (context and added lines), counted across all hunks, and is what Task 9's highlighter indexes. `no-newline` rows keep the previous row's side and index. `openAt` is `newNumber`, or for a removed or `no-newline` line the last `newNumber` before it in the hunk, else `max(1, newStart)`.

`bodyMessage` uses the copy in Global Constraints. Modes print their last three digits; `binary` with a null size prints "Binary file changed"; `too-large` appends `· ${countsText}` when counts exist; `submodule` prints the first seven characters of the commit.

- [ ] **Step 1: Write the failing tests:**

```ts
test('builds file, hunk and line rows, and only a header for a collapsed file', …);  // overrides new Map([['big.lock', true]]) → one row for big.lock
test('starts files collapsed by their hint, and lets overrides win both ways', …);
test('numbers each side for highlighting and points removed lines at the nearest new line', …);
  // hunk @@ -1,3 +1,3 @@: context(1,1) removed(2) added(2) context(3,3) → sideIndex new 0, old 1, new 1, new 2; openAt 1, 1, 2, 3
test('keeps row keys stable when lines are added above', …);  // the key of the 'three' line is unchanged after inserting a hunk above it
test('writes each body message', …);   // binary 1258291 bytes → 'Binary file changed · 1.2 MiB'; mode → 'File mode changed 644 → 755'; type-change file→symlink; submodule sha / null; folder; not-loaded; too-large with and without counts
test('summarises counts', …);          // one file → '1 file changed · +1 −0'; null counts are skipped in totals
test('finds the file a row belongs to', …);
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm test src/renderer/changes-rows.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.** Run `pnpm test src/renderer/changes-rows.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(changes): flatten changed files into diff rows"`

---

### Task 9: Changes pane and diff stream

**Files:**
- Create: `src/renderer/diff-highlight.ts`, `src/components/right-panel/changes/changes-pane.tsx`, `src/components/right-panel/changes/diff-stream.tsx`, and tests `changes-pane.test.tsx` and `diff-stream.test.tsx` (`// @vitest-environment jsdom`)

**Interfaces:**
- Consumes: `useChanges` (Task 7); everything from Task 8; `TokenLine` from `@/components/code/highlighted-tokens`; `languageFor` from `@/renderer/file-display`; `OpenMenu` from `@/components/right-panel/files/open-menu` (props `root`, `path`, `line?`); `FILE_HIGHLIGHT_MAX_BYTES`.
- Produces:
  - `useDiffHighlights(files: ChangedFile[], visibleFileIndexes: number[]): (fileIndex: number, side: 'old' | 'new', sideIndex: number) => Token[] | null`. For each visible file with `hunks` and a `languageFor` language whose old-side and new-side texts each fit in `FILE_HIGHLIGHT_MAX_BYTES`, it calls `code.highlight({ code, language, themes: code.getThemes() }, callback)` once per side. Results are cached in a `WeakMap` keyed by the `ChangedFile` object, and the hook re-renders when a callback lands. Files from a new read are new objects, so they are highlighted afresh.
  - `ChangesPane({ root, active, onOpenFile }: { root: string; active: boolean; onOpenFile: (path: string) => void })`
  - `DiffStream({ root, files, jumpTo, onOpenFile }: { root: string; files: ChangedFile[]; jumpTo: { path: string; token: number } | null; onOpenFile: (path: string) => void })`

**ChangesPane:**
- With no snapshot, it shows "Reading changes…", or when `failed`, "Changes couldn't be read" with a Retry button that calls `refresh`.
- `not-a-repo` shows "Not a git repository"; `git-unavailable` shows "Git isn't available"; no files shows "No uncommitted changes".
- Otherwise the header holds the `summaryText`, the branch (or `commit.slice(0, 7)` when detached), "Checked Ns ago" (re-rendered each second, "Checked just now" under 1 s), or "Changes couldn't be read" while `failed`, and an icon refresh button (`aria-label="Refresh changes"`, with a tooltip). Below it is the file list: a collapsible list (`aria-label="Changed files"`) with a toggle (`aria-expanded`), one button per file showing `statusLetter`, the path or `old → new`, and `countsText`. Clicking a file sets `jumpTo`. The list's open state is component state, so it persists per tab.

**DiffStream:**
- One `useVirtualizer` over `buildRows(files, overrides)`, with `estimateSize` from the row kind and no measuring.
- A file row holds the chevron button (`aria-expanded`, toggling the override), the status letter, a "Conflicted" badge for conflicted files, the path, the counts, and, unless the file is deleted or a folder, an `OpenMenu` (with that file's current line) and an icon button "Open in Files" (with a tooltip) that calls `onOpenFile(path)`.
- A copy of the current file's header is drawn absolutely at the top of the scroller, using `fileIndexAt(rows, firstVisibleIndex)`, whenever the first visible row is not that file's own header. This is the sticky header.
- A hunk row shows `@@ … @@ header` muted. A line row shows the old and new gutters, a `+`/`-`/space marker, and the text: highlighted tokens when available, else plain. Added rows are tinted with `bg-green-500/10`, removed rows with `bg-red-500/10`; no other colours are added. `no-newline` rows are muted.
- Clicking a line row sets the current line `{ path, line: openAt }` and highlights the row, as `file-viewer.tsx` does.
- Long lines scroll horizontally, with the content width set from the longest line, as `file-viewer.tsx` does.
- `jumpTo` expands the target file and calls `scrollToIndex(index of f:${path}, { align: 'start' })`.
- Across refreshes, before rows change, the key of the first visible row is recorded. After they change, the stream scrolls back to that key's new index; when the key is gone, it scrolls to the nearest remaining row of the same file, else stays put.

- [ ] **Step 1: Write the failing tests.** jsdom has no layout, so stub `getBoundingClientRect`/`offsetHeight` the way `file-viewer.test.tsx` does, or mock `@tanstack/react-virtual` to render every row.

```ts
// changes-pane.test.tsx — mock useChanges
test('shows each whole state', …);  // null+failed → Retry calls refresh; not-a-repo; git-unavailable; empty files → 'No uncommitted changes'
test('summarises and lists files, and jumps to one', …);  // '2 files changed · +3 −1', 'main', 'R old.ts → new.ts', click → DiffStream receives jumpTo { path }
test('shows a failed refresh in the header while keeping the last result', …);
// diff-stream.test.tsx
test('renders hunks with gutters, markers and tints', …);
test('collapses and expands a file', …);   // big file starts collapsed (no line rows); click chevron → lines appear
test('passes the clicked line to the Open menu', …);      // click the removed line → OpenMenu mock receives line = nearest new-side number
test('offers no actions on deleted files and folders, and Open in Files elsewhere', …);  // click 'Open in Files' → onOpenFile('src/a.ts')
test('shows the conflicted badge and each body message', …);
test('keeps the reading position across a refresh', …);   // scrollToIndex called with the new index of the previous top key
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm test src/components/right-panel/changes`. Expected: FAIL.
- [ ] **Step 3: Implement** `diff-highlight.ts`, `diff-stream.tsx`, then `changes-pane.tsx`.
- [ ] **Step 4: Run them and confirm they pass.** Run `pnpm test src/components/right-panel/changes`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(changes): render the changes pane and diff stream"`

---

### Task 10: Panel tab, entry, and shortcut

**Files:**
- Modify: `src/renderer/panel-tabs.ts` (+ test), `src/components/right-panel/panel-tabs.tsx` (+ test), `src/components/right-panel/tool-entries.tsx` (+ test), `src/components/right-workspace.tsx` (+ test)

**Interfaces:**
- Consumes: `ChangesPane` (Task 9).
- Produces:
  - `export type ChangesPanelTab = { kind: 'changes'; id: string; projectPath: string }`, with `PanelTab = TerminalPanelTab | FilePanelTab | ChangesPanelTab`
  - `openChangesTool(state: PanelTabsState, projectPath: string, newId: string): PanelTabsState` selects the project's Changes tab if there is one, and otherwise appends one.
  - `ToolList` / `ToolMenuItems` handlers gain `onChanges: () => void`.

Details:
- In `tool-entries.tsx`, the `review` entry becomes `{ id: 'changes', label: 'Changes', Icon: FileDiff }`. With a project it gets `{ onSelect: onChanges, hint: 'Ctrl+Shift+G', shortcut: 'Control+Shift+G' }`; without one, `{ hint: 'Open a project first' }`. Update the comment above `TOOL_ENTRIES` to say that Terminal, Files, and Changes exist.
- In `panel-tabs.tsx`, a changes tab has the `FileDiff` icon, the label "Changes", the project path as its tooltip, the panel id `panel-${id}`, and no double-click pin.
- In `right-workspace.tsx`:
  - add `openChanges` beside `openFiles`;
  - add a `showChanges` ref, handled in the existing capture listener for `event.code === 'KeyG' && event.shiftKey`, which opens the panel and the tool and does nothing without a project;
  - render each changes tab in a `role="tabpanel"` div, `hidden` unless selected, holding `<ChangesPane root={tab.projectPath} active={open && selectedId === tab.id} onOpenFile={(path) => openProjectFile(tab.projectPath, path, false)} />`;
  - pass `onChanges` to `ToolList` and `ToolMenuItems`.

- [ ] **Step 1: Write the failing tests:**

```ts
// panel-tabs.test.ts
test('opens one Changes tab per project and reselects it', …);  // '/a' twice → 1 tab; '/b' → 2 tabs; closeTab works
// tool-entries.test.tsx
test('Changes is enabled with a project and shows its shortcut', …);  // menuitem 'Changes' aria-keyshortcuts 'Control+Shift+G'; without a project it is disabled with 'Open a project first'
// panel-tabs.test.tsx
test('labels a Changes tab and shows its project as the tooltip', …);
// right-workspace.test.tsx (mock ChangesPane)
test('Ctrl+Shift+G opens the panel on Changes and reuses the tab', …);
test('Ctrl+Shift+G does nothing without a project', …);
test('Open in Files from Changes opens a Files preview tab for that file', …);  // mock ChangesPane calls onOpenFile('src/a.ts') → a file tab 'a.ts' is selected
test('only the selected Changes tab is active', …);  // the mock records `active`; switching to a terminal tab → false; hiding the panel → false
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm test src/renderer/panel-tabs.test.ts src/components/right-panel src/components/right-workspace.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement the changes listed above.**
- [ ] **Step 4: Run the whole suite, lint, and typecheck.** Run `pnpm test && pnpm lint && pnpm exec tsc --noEmit`. Expected: all pass, with no lint errors.
- [ ] **Step 5: Commit.** `git commit -m "feat(changes): open the Changes tool in the right panel"`

---

### Task 11: Drive the running app

No code is expected. Fix anything found in the task that owns it, with a regression test there.

- [ ] **Step 1:** Run `pnpm start`. Open a conversation in a git project and press Ctrl+Shift+G. The panel opens on a "Changes" tab.
- [ ] **Step 2:** From a Fractal terminal, edit a tracked file, create an untracked file, `git mv` a file, and `chmod +x` one. Each appears within about 2 s with the right letter, counts, and body, and the header's "Checked Ns ago" keeps updating.
- [ ] **Step 3:** Have an agent edit files in a conversation. Its edits appear without pressing refresh.
- [ ] **Step 4:** Click a file in the list, and the stream jumps there. Collapse and expand files. Scroll so a file's header has scrolled away: its header stays pinned at the top.
- [ ] **Step 5:** Click a removed line, then Open → VS Code. It opens at the nearest new-side line. "Open in Files" opens a Files preview tab on that file.
- [ ] **Step 6:** Run `pnpm add -D` of any package in a scratch repository. The lockfile change starts collapsed.
- [ ] **Step 7:** `git commit -am wip`. The list empties to "No uncommitted changes".
- [ ] **Step 8:** Open a project that is not a repository: "Not a git repository". Open a project that is a subfolder of a repository: only its own changes show.
- [ ] **Step 9:** Hide the window or switch to a terminal tab, and confirm (with a log line in `readChanges`, removed afterwards) that polling stops.
- [ ] **Step 10:** Check the header, list, and stream at 320 px and 720 px panel widths, and leave the judgement of proportions to human review.
- [ ] **Step 11:** Run `pnpm test && pnpm lint && pnpm exec tsc --noEmit` one last time.
