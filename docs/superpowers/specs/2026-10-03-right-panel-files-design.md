# Right panel Files tool design

## Intent

Make Files, one of the right panel's "Soon" entries, a working tool: a read-only browser for the project's files, so the user can look around the repo while the agent works without leaving Fractal. It is a plain repo browser. It knows nothing about conversations and does not mark what the agent read or edited; that idea may live in Review later. Fractal never writes files through it; when the user wants to change one, Files hands it to their own editor.

The shape follows Claude's and Codex's desktop apps: tabs named after the file, a tree beside the file inside the tab, a filter above the tree, and an "Open" menu that hands the file to an editor.

## What exists today

The right panel (`right-workspace.tsx`) holds only terminal tabs (`TerminalTab` in `right-panel/terminal-tabs.tsx`). `right-panel/tool-entries.tsx` lists Review, Terminal, Browser, Files, and Side chat, and hard-codes `available = id === 'terminal'`. The panel is 320–720px wide (`right-panel-layout.ts`) and shared across every mode. `projectPath` in `App` follows the selected conversation's project and is null on the home screen; terminals fix their directory when they are created.

Main already reads files for attachment previews. `attachments/preview.ts` classifies a file as text, binary, or missing using a NUL-byte check plus strict UTF-8 decoding that tolerates a character cut off at a size limit. `attachments/sniff.ts` has `readHead`. In the renderer, `message-attachments.tsx` picks a highlighting language with `code.supportsLanguage(extension)` and formats sizes in KiB/MiB, and `HighlightedCommand` highlights any language through `@streamdown/code`. At startup, main merges the login shell's PATH into `process.env.PATH` on Linux and macOS (`shell-environment.ts`, applied in `main.ts`).

## Tabs

The panel's tab list becomes a union of terminal tabs and file tabs, and the tab row renders each kind with its own icon and label. Terminal tabs and their behaviour do not change.

A file tab belongs to one project, fixed when the tab is created, exactly as a terminal's directory is. Selecting a conversation in another project does not change existing file tabs. A file tab shows at most one file. It is labelled with the file's name, and its tooltip shows the full path. A tab with no file yet is labelled "Files".

Choosing Files from the empty state or the `+` menu selects the current project's most recently active file tab if it has one, and otherwise creates a file tab with no file, which shows the tree and a viewer reading "Select a file". On the home screen, where there is no project, the Files entry is disabled with the hint "Open a project first". Files has no keyboard shortcut in this version.

### Preview tabs

Opening files follows VS Code's preview rules:

- Clicking a file that is already open in a tab selects that tab.
- Otherwise, if a preview tab exists, it shows the clicked file instead of its current one.
- Otherwise, a new preview tab opens.

Each project has at most one preview tab, and its title is italic. The rule is per project because a file tab never changes project, so a preview tab cannot take a file from another project. A preview tab becomes permanent when the user double-clicks the file in the tree, double-clicks the tab, or chooses "Open in new tab" by middle-clicking the file or from its context menu. "Open in new tab" always opens a permanent tab. The "Files" tab with no file counts as a preview tab, so the first file opened, by any of these routes, fills it rather than leaving it empty beside a new tab. A tab with no file cannot be made permanent.

## Tree

Each project has one tree, shared by that project's file tabs and shown inside whichever of them is selected. It remembers which folders are expanded. The tree sits on the left of the viewer, facing the conversation. A list-icon toggle at the start of the tab row shows or hides it; the toggle is visible only while a file tab is selected.

Folders sort before files, each group alphabetically. Folders load when first expanded. `.git` is never shown. In a git repository, gitignored entries are shown dimmed. A symlink that resolves outside the project is shown, marked as outside the project, and cannot be opened.

A name filter sits at the top of the tree. Typing filters to matching paths across the whole project, not only expanded folders. It searches tracked and untracked files that are not gitignored. In a project that is not a git repository, it searches every file up to a cap, and says so when it reaches the cap rather than silently showing partial results. Searching file contents is not part of this version.

### Narrow panels

When the panel is narrower than the tree plus a readable viewer, the tree no longer sits beside the viewer. The toggle instead opens it as an overlay above the viewer, and choosing a file closes the overlay. The threshold starts at 560px and is tuned by feel. The threshold rule is a pure function in `right-panel-layout.ts`, beside the existing layout rules.

## Viewer

The viewer header shows a breadcrumb (`project › dir › file`), a button that copies the file's absolute path, and the Open menu.

Text files are syntax-highlighted with the same `@streamdown/code` highlighter and themes as conversation code blocks, so files look like code in chat. They are plain text until the highlighter loads. The language comes from `languageFor` as it is today: the file extension, or for a file with no extension its lowercased name. Shiki already accepts `mts`, `cts`, `dockerfile`, and `makefile` as language ids, so no override map is needed. Anything else is plain text.

Lines are virtualised with `@tanstack/react-virtual`, so only visible lines are rendered. A line-number gutter runs down the left. Clicking a line marks it as the current line, which is highlighted and is the line the Open menu passes to editors that accept one. Text can be selected and copied. Long lines scroll horizontally; there is no wrap toggle.

The viewer is read-only. When the file changes on disk, the viewer re-reads it and re-renders, keeping the scroll position by line number. Nothing announces the change.

Files that are not shown as text are shown as a short message with the Open menu beneath it:

- Binary: "Binary file · 1.2 MiB".
- Over the viewing limit: "Too large to preview · 14.0 MiB".
- Deleted: "This file no longer exists". The tab stays open and recovers if the file reappears.
- Unreadable: "This file cannot be read".

Highlighting stops above `FILE_HIGHLIGHT_MAX_BYTES` (256 KiB), and such files are shown as plain text, because Shiki tokenises on the renderer's main thread. Files above `FILE_VIEW_MAX_BYTES` (2 MiB) are not loaded at all. Both are Fractal's own bounds on renderer work and IPC size, not values anything else requires, and they are starting values.

## Process boundary

The preload exposes a typed `files` API on `window.fractal`. The contract lives in `src/shared/files-contract.ts` and follows the terminal contract's shape: one invoke channel, one event channel, and payloads validated on both sides. Main accepts calls only from the app window's main frame, as the terminal IPC does.

| Method | Result |
|---|---|
| `listDirectory(root, path)` | Entries `{ name, kind: 'file' \| 'directory', symlink, ignored, outside }`, sorted folders first; `.git` removed. For a symlink, `kind` is its target's kind, so a linked folder can be expanded; a broken link is a file that reads as missing |
| `readFile(root, path)` | `{ kind: 'text', content, size }`, `{ kind: 'binary', size }`, `{ kind: 'too-large', size }`, `{ kind: 'missing' }`, or `{ kind: 'unreadable' }` |
| `listFiles(root)` | `{ paths, truncated }` for the filter |
| `watch(watchId, root, path)` / `unwatch(watchId)` | `changed` events carrying the `watchId` |
| `editors()` | The detected editors, in the order in the Open menu table |
| `open(editorId, root, path, line?)` | Opens the file in that editor, or reports why it could not |

`path` is always relative to `root`. Every method that takes a root checks it before doing anything else:

1. `root` must be the project path of a conversation main already knows through the conversation service. A renderer that sends `/` as a root is refused rather than given the whole disk.
2. `root/path` is resolved with `realpath` and must be inside `realpath(root)`. This rejects `../` escapes and symlinks that lead out of the project. A symlink into the project, such as pnpm's links into `node_modules/.pnpm`, is allowed.

Gitignore status comes from one `git check-ignore --stdin` call per directory listing. `listFiles` uses `git ls-files --cached --others --exclude-standard` in a git repository. Otherwise it walks the directory, skipping `.git`, and stops at `FILE_LIST_MAX_ENTRIES` (50,000), with `truncated` set. A project that is not a repository, or a machine without git, gets no ignored marks and the walking filter.

Text and binary classification uses the same rule as attachment previews: a NUL byte or invalid UTF-8 makes a file binary.

### Watching

The renderer watches every expanded folder and every open file, and stops watching when a folder collapses or a tab closes. Main uses a non-recursive `fs.watch` on directories only. A file is watched through its parent directory, filtered to its name, because editors and agents often save by writing a temporary file and renaming it over the original, and a watch on the file itself would follow the old copy. Events are debounced per watch (starting at 100 ms), because agents write in bursts. A `changed` event tells the renderer to fetch again; it carries no content.

Watches belong to the WebContents that created them, and events go only to that owner, as with terminals. All of an owner's watches close when it navigates, reloads, or is destroyed. Closing a watch is idempotent.

## Open menu

The viewer's Open button runs the editor used last, and its chevron lists every detected editor plus "System default" and "Show in folder". The last editor or "System default" that opened a file successfully is stored as a new `fileOpener` setting in the existing settings store; "Show in folder" is not remembered, since it does not open the file. Until something has been chosen, or if the remembered editor is no longer detected, the button runs the first detected editor, or "System default" if none was detected.

On Linux and macOS, main detects editors by checking `PATH` for a fixed list of commands. It waits for the startup login-shell PATH merge to finish, then caches the result until the app restarts.

| id | Command | Opens at a line |
|---|---|---|
| `vscode` | `code <root> -g <file>:<line>` | Verified from `code --help` |
| `cursor` | `cursor <root> -g <file>:<line>` | Assumed from VS Code; verify during planning |
| `zed` | `zed <file>:<line>` | Verified from `zed --help` |
| `sublime` | `subl <file>:<line>` | Verify during planning |

Passing the project folder to `code` and `cursor` is meant to reuse that project's window; confirm this during planning. With no current line, the line suffix is omitted. "System default" uses `shell.openPath`. "Show in folder" uses `shell.showItemInFolder`.

The renderer sends only an editor id, root, path, and optional line. Main applies the same root and path checks as every other method, maps the id to a fixed argument list, and starts the editor detached with `shell: false`. No string from the renderer is ever run as a command. A launch failure is shown as a short message in the viewer.

On Windows, the menu offers only "System default" and "Show in folder". Editor command-line launchers there are `.cmd` batch files, which Node refuses to start without `shell: true` since its April 2024 security release (CVE-2024-27980). Starting them through `cmd.exe` would let file names containing `&`, `%`, `^` or `!` act as commands, which breaks the rule above.

## Shared helpers

Files reuses code that attachments introduced, by moving it to shared homes rather than copying it:

- The text/binary decode in `attachments/preview.ts` becomes a helper that both attachment previews and `readFile` call.
- `languageFor` and `formatSize` move out of `message-attachments.tsx` into a renderer helper, and `languageFor` gains the override map.
- The token-to-span rendering in `HighlightedCommand` is shared with the viewer's virtualised lines, while `HighlightedCommand` keeps rendering every token at once for short snippets.

Files does not use the attachment preview channel. Attachment previews are allowed per conversation (`attachmentAllowed`), while Files is confined to a project root; the two scopes are different rules and stay separate.

## Verification

Main-process unit tests run against real temporary directories, with `git init` where git behaviour matters, so ignore handling is tested rather than mocked:

- **Root and path checks:** an unknown root, `../` escapes, absolute paths, and a symlink pointing out of the project are rejected; a symlink into `node_modules/.pnpm` is allowed.
- **`listDirectory`:** sort order, `.git` removed, ignored entries marked, nothing marked in a directory that is not a repository.
- **`readFile`:** text, binary, too-large, missing, and unreadable.
- **`listFiles`:** the git list in a repository; a walk with `truncated` set at the cap outside one.
- **Watching:** a temp-file-and-rename save still produces `changed`; rapid writes produce one event; events reach only the owner; all watches close when the owner is destroyed.
- **Editors:** each id maps to exactly its argument list, with and without a line; unknown ids are refused; detection is off on Windows.

Contract tests check that invalid payloads are refused on both sides, in the style of `terminal-contract.test.ts`. Renderer unit tests cover the tab rules (selecting an open file, replacing the preview tab, never more than one preview tab, double-click to make permanent, one "Files" tab per project, the disabled entry with no project) and the narrow-panel threshold function.

Drive the running app to check the flows: open Files, expand folders, filter, open a file, have the next click replace it, then make the tab permanent. From a terminal tab, append to the open file, rename a new file over it, and delete it; the viewer should update live, show "This file no longer exists", and recover when the file comes back. Narrow the panel and use the tree overlay. Use the Open menu with VS Code and Zed at a line, and "Show in folder". Whether the tree and viewer widths, the overlay, and the italic preview title feel right is left to human review. macOS editor detection is covered by unit tests only, since no Mac is available to drive.

Run the tests, `pnpm lint`, and `pnpm exec tsc --noEmit`.

## Out of scope

Editing files; marking what the agent read or edited; searching file contents (`?` in the filter); image previews; rendered Markdown; word wrap; a keyboard shortcut for Files; a custom editor command in Settings; opening editors on Windows; a control to expand the panel past 720px, which is designed separately; restoring file tabs after an app restart.
