# Right panel Changes tool design

## Intent

Make the right panel's placeholder "Review" entry a working tool named **Changes**: a read-only view of the project's uncommitted changes, so the user can read what the agent (or anyone else) has changed without leaving Fractal. It shows the git working tree against `HEAD`, untracked files included, as one scrolling stream of unified diffs, and keeps itself current while files change.

It is a plain diff reader. Fractal never writes to the repository through it: no staging, reverting, or committing. When the user wants to change a file, Changes hands it to their editor through the same Open menu as Files. It knows nothing about conversations and does not attribute changes to the turn that made them.

The shape follows GitHub's "Files changed" view and Codex's Review pane: a summary header, a list of changed files, and every file's diff stacked below it in one scroll.

## What exists today

`right-panel/tool-entries.tsx` lists Review, Terminal, Browser, Files, and Side chat; Review is disabled with the hint "Soon". `renderer/panel-tabs.ts` models the panel's tabs as a union of terminal tabs and file tabs, each file tab fixed to one project when created. `right-workspace.tsx` renders the tabs and handles the Ctrl+` and Ctrl+Shift+F shortcuts.

Main already runs git for Files: `files/git.ts` has `runGit`, which spawns `git -C <cwd>` with `shell: false` and `GIT_OPTIONAL_LOCKS=0`, buffering all of stdout. `files/files-ipc.ts` checks every root against the conversation service (`knowsProject`) before doing anything. `text-file.ts` has `decodeText`, the shared text/binary rule (a NUL byte or invalid UTF-8 makes a file binary). In the renderer, `renderer/file-display.ts` has `languageFor` and `formatSize`, the Files viewer virtualises lines with `@tanstack/react-virtual`, highlights with `@streamdown/code` up to `FILE_HIGHLIGHT_MAX_BYTES`, and has the Open menu (`right-panel/files/open-menu.tsx`).

## Entry and tab

The Review entry is renamed **Changes** and keeps the `FileDiff` icon. It is enabled while a project is selected, with the hint and shortcut **Ctrl+Shift+G**, and otherwise disabled with the hint "Open a project first", as Terminal and Files are. The shortcut is handled in `right-workspace.tsx` beside the existing two.

`PanelTab` gains a third kind, `{ kind: 'changes'; id; projectPath }`. A Changes tab belongs to one project, fixed when it is created; selecting a conversation in another project does not change it. Each project has at most one Changes tab. Choosing Changes, from the empty state, the `+` menu, or the shortcut, selects the current project's Changes tab if it has one and otherwise creates it. The tab is labelled "Changes" and its tooltip shows the project path. Closing it follows the existing tab rules.

## Layout

From top to bottom, inside the tab:

1. **Summary header.** "N files changed · +X −Y", the branch name (or the short commit when `HEAD` is detached), a "Checked Ns ago" indicator, and a refresh button. While a read has failed, the header says so in place of "Checked Ns ago" and keeps showing the last good result below.
2. **File list.** One compact row per changed file: a status letter (M, A, D, R, U, T for type change), the path (`old → new` for a rename), and its +/− counts. Clicking a row scrolls the stream to that file and expands it if it was collapsed. The list can be collapsed to give the diff more room; its collapsed state is remembered per tab.
3. **Diff stream.** For each file, a header that sticks to the top of the stream while its diff is on screen, holding the status, path, +/−, a collapse chevron, and the file's actions; then the file's diff. Rows are virtualised across the whole stream with `@tanstack/react-virtual`, so a long stream renders only what is visible.

Files appear in the order git reports them (path order). Whole states that replace the list and stream:

- Clean tree: "No uncommitted changes".
- Not a repository: "Not a git repository".
- git cannot be started: "Git isn't available".
- The first read failed: "Changes couldn't be read" with a Retry button.

## Diff content

**What is compared.** The working tree against `HEAD`, as one diff, so whether a change is staged makes no difference to what is shown. Untracked files that are not gitignored appear as added files, their whole content shown as additions. In a repository with no commits, everything is compared against the empty tree. Gitignored files never appear.

**Rendering.**

- A unified diff, with old and new line-number gutters. Added and removed lines are tinted using theme tokens; context lines are not.
- Three lines of context, as git's default. Each hunk is preceded by a separator row showing git's function context from the `@@` line. Hidden lines between hunks cannot be expanded in this version.
- Lines are syntax-highlighted with the same highlighter, themes, and `languageFor` as the Files viewer, line by line, so a construct that spans lines, such as a block comment, may colour imperfectly. A file whose diff text is over `FILE_HIGHLIGHT_MAX_BYTES` is shown unhighlighted. Lines are plain text until the highlighter loads.
- "No newline at end of file" is shown as a muted row after the line it applies to.
- Long lines scroll horizontally; there is no wrap toggle.

**Per-file cases.**

| Case | Shown as |
|---|---|
| Modified | Hunks |
| Added, or untracked | All-added hunks |
| Deleted | All-removed hunks |
| Renamed (git's rename detection) | `old → new` in the header, then the hunks if the content also changed |
| Binary | "Binary file changed · 1.2 MiB" (the current size, or the old size when deleted) |
| Mode change only | "File mode changed 644 → 755" |
| Type change (file ↔ symlink) | "Changed from a file to a symlink" or the reverse |
| Submodule | "Submodule moved to `abc1234`", or "Submodule has uncommitted changes" |
| Conflicted | A "Conflicted" badge, and the working file diffed against `HEAD`, so its conflict markers show as additions |

**Bounds.** These are Fractal's own limits on renderer work and IPC size, and are starting values:

- A file whose diff is over `CHANGES_FILE_MAX_LINES` (5,000) or `CHANGES_FILE_MAX_BYTES` (1 MiB) shows "Diff too large to show · +X −Y" and its actions, with no hunks.
- An untracked file over `FILE_VIEW_MAX_BYTES` is treated the same way, and is not read beyond what is needed to classify it.
- Once the diffs sent in one read reach `CHANGES_TOTAL_MAX_BYTES` (8 MiB), the remaining files are still listed with their status and +/−, but show "Not loaded: too many changes" in place of a diff, and the result is marked `truncated`. The file list never silently drops a file.
- A file with more than `CHANGES_COLLAPSE_LINES` (500) changed lines, such as a lockfile, starts collapsed.

**Actions on a file.** Each file header has the Files tool's Open menu (the remembered editor, every detected editor, System default, Show in folder) and an "Open in Files" item that opens the file in a Files tab under the Files tool's tab rules. Clicking a diff line marks it as the current line, which is highlighted and is the line the Open menu passes to editors that accept one: the line's new-side number, or for a removed line the nearest new-side line before it. Deleted files have only "Show in folder" for their parent and no "Open in Files".

**Across refreshes.** Collapse state is kept per file path. The scroll position is kept by anchoring to the topmost visible file and line, as the conversation timeline anchors its reading position. A file that is no longer changed drops out; a new one appears in path order. Nothing announces either.

## Keeping current

The renderer polls while it is looking. A `useChanges(projectPath)` hook reads the project's changes:

- every `CHANGES_POLL_MS` (2,000 ms) while the Changes tab is selected and the document is visible;
- immediately when the tab becomes selected, when the window regains focus or becomes visible, and when the refresh button is pressed.

It never has two reads in flight: a tick that arrives during a read is skipped, and a manual refresh during a read runs once that read finishes. When the tab is not selected or the window is hidden, nothing runs. Each read passes the fingerprint of the last result, so an unchanged tree costs one `git status` and a few `lstat` calls and sends almost nothing across IPC.

A read that fails keeps the last good result on screen and shows the failure in the header; the next tick tries again.

## Process boundary

The preload exposes a typed `changes` API on `window.fractal`. The contract lives in `src/shared/changes-contract.ts`, follows the files contract's shape, and validates payloads on both sides with zod. It has one invoke channel and no event channel. Main accepts calls only from the app window's main frame, as the files and terminal IPC do.

| Method | Result |
|---|---|
| `read(root, fingerprint?)` | `{ kind: 'unchanged', fingerprint }` when the tree matches `fingerprint`; `{ kind: 'changes', fingerprint, head, files, truncated }`; `{ kind: 'not-a-repo' }`; `{ kind: 'git-unavailable' }`; or `{ kind: 'error', message }` |

`head` is `{ branch?: string; commit?: string }` (`commit` absent before the first commit). Each entry of `files` is `{ path, oldPath?, status, added, removed, collapsed, body }`, with `path` relative to `root` and `/`-separated, and `body` one of `{ kind: 'hunks', hunks }`, `binary`, `too-large`, `mode`, `type-change`, `submodule`, or `not-loaded`. A hunk is `{ header, oldStart, newStart, lines }`, and a line is `{ kind: 'context' | 'added' | 'removed' | 'no-newline', text, oldNumber?, newNumber? }`.

`root` is checked exactly as Files checks it: it must be the project path of a conversation main already knows through the conversation service. The `knowsProject` check moves out of `files-ipc.ts` into a helper both IPC modules call. `runGit` moves from `files/git.ts` to `src/main/git.ts`, since it is no longer Files' alone.

### Reading changes

`src/main/changes/changes-service.ts` does the work, in this order:

1. **Status.** `git status --porcelain=v2 -z --branch --untracked-files=all` gives the branch, the `HEAD` commit, every changed and untracked path, rename sources, submodule state, and conflicts. Exit 128 is `not-a-repo`; a git that cannot start is `git-unavailable`.
2. **Fingerprint.** A hash of the status output plus the `lstat` size and modification time of every listed path, with a path that no longer exists recorded as missing. Status alone is not enough, because a file that is already modified stays `M` when it changes again. If it equals the fingerprint passed in, return `unchanged`.
3. **Counts.** `git diff HEAD --numstat -z --find-renames` gives the +/− per file and marks binary files. With no commits, the empty tree's id stands in for `HEAD`.
4. **Patch.** `git diff HEAD --no-color --no-ext-diff --no-textconv --find-renames --unified=3` gives the hunks, read through a stream that stops at `CHANGES_TOTAL_MAX_BYTES`. The patch is parsed in main into the structure above. File paths always come from the `-z` outputs of steps 1 and 3, never from patch headers, so names with spaces, quotes, non-ASCII characters, or newlines survive. Patch sections are matched to files in order.
5. **Untracked files.** Read directly and classified with `decodeText`, and turned into one all-added hunk. Fractal does not use `git add -N` to include them in the diff, because that writes to the index.

Every command runs with `shell: false` and `GIT_OPTIONAL_LOCKS=0`, so polling never takes `index.lock` and cannot collide with an agent running git in the same repository. `--no-ext-diff` and `--no-textconv` keep the output parseable and stop a configured diff program from being started every two seconds. `runGit` buffers all of stdout, so the patch step uses a bounded reader instead, as `listGitFiles` already does for its path cap. No command Fractal runs here writes to the repository.

## Verification

Main-process unit tests run against real temporary repositories made with `git init`, so git behaviour is tested rather than mocked:

- **Root checks:** an unknown root is refused.
- **States:** a clean repository returns no files; a non-repository returns `not-a-repo`; a repository with no commits diffs against the empty tree; a missing git binary returns `git-unavailable`.
- **Kinds:** modified, added, deleted, renamed, renamed and modified, untracked, conflicted, mode-only, type change, binary, and submodule files each produce the right status and body.
- **Fingerprint:** reading an unchanged tree twice returns `unchanged`; editing an already-modified file, touching a new untracked file, and committing each change the fingerprint.
- **Parsing:** several hunks in one file, function context in the `@@` line, "No newline at end of file", CRLF lines, and paths containing spaces, non-ASCII characters, and a newline.
- **Bounds:** a file over the per-file cap is `too-large`; reaching the total cap marks later files `not-loaded` and sets `truncated`; a file over the collapse threshold has `collapsed` set.
- **No writes:** the index file's bytes and modification time are unchanged after reads, and no `index.lock` is created.

Contract tests check that invalid payloads are refused on both sides, in the style of `files-contract.test.ts`. Renderer unit tests cover the tab rules (one Changes tab per project, reselecting the existing one, the disabled entry with no project), polling only while the tab is selected and the document visible, no overlapping reads, the last good result surviving a failed read, and collapse state and scroll anchor surviving a refresh.

Drive the running app to check the flows: open Changes with Ctrl+Shift+G, have an agent edit files and watch them appear within a couple of seconds, edit a file from a Fractal terminal, create an untracked file, then `git commit` and watch the list empty. Jump to a file from the list, collapse and expand files, use the Open menu at a clicked line and "Open in Files". Check a large lockfile change starts collapsed, and that a non-git project shows "Not a git repository". Whether the header, file list, and stream proportions feel right at 320px and 720px is left to human review.

Run the tests, `pnpm lint`, and `pnpm exec tsc --noEmit`.

## Out of scope

Staging, unstaging, reverting, and committing; a staged/unstaged split; comparing a branch against its base; marking files as viewed; attributing changes to conversations or turns; a side-by-side view; expanding hidden context lines; word-level highlighting within changed lines; inline comments sent to the agent; a file-system watcher for instant updates; restoring Changes tabs after an app restart.
