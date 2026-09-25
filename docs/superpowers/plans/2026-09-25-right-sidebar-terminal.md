# Right Sidebar and Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a floating right workspace to Execute mode with multiple real terminal tabs rooted in the selected conversation's project.

**Architecture:** The renderer owns panel and tab presentation while xterm.js renders each terminal. A narrow typed preload bridge carries terminal operations to Electron main, where a per-window session service owns node-pty processes and forwards data and exit events only to their creator. The panel stays mounted when hidden or when Execute is inactive, so tabs and shells survive those UI changes.

**Tech Stack:** Electron 43, Forge 7, Vite 5, React 19, TypeScript 5.9, Tailwind v4, Radix/shadcn components, Vitest 2, `@xterm/xterm`, `@xterm/addon-fit`, and `node-pty`.

**Spec:** [docs/superpowers/specs/2026-09-25-right-sidebar-terminal-design.md](../specs/2026-09-25-right-sidebar-terminal-design.md)

## Global Constraints

- Start with the right panel closed; keep the approved Review, Browser, and Files menu entries disabled, and omit Side chat.
- Match the left floating sidebar's 8px inset, sidebar theme tokens, rounded border, and subtle shadow; preserve Fractal's existing mode switch.
- New terminal tabs use the selected conversation's `projectPath`; when none is selected, Electron main supplies its `process.cwd()`.
- Existing tabs retain their original working directory. Hide and mode switches preserve their shells; closing a tab, renderer navigation, window destruction, or app quit ends them.
- Keep `contextIsolation: true` and `nodeIntegration: false`. The renderer receives only typed terminal methods, never Node or raw Electron APIs.
- Do not create a branch or commit unless the user explicitly requests it. Leave the existing Claude probe edits untouched.
- Before changing Forge configuration, reread `docs/environment-notes.md`; preserve `vite.renderer.config.mts` and `@vitejs/plugin-react` 4.x.
- Do not use Playwright merely to confirm clean UI edits. Run focused tests, `pnpm lint`, `pnpm exec tsc --noEmit`, and `pnpm package`.

## Review Focus

- A selected project directory is deleted before terminal creation: show a specific start failure, create no PTY, and let the user retry after fixing the path. Task 3 tests this.
- A PTY emits its prompt before `create()` resolves: the mounted renderer listener receives the prompt without losing it. Task 5 tests this.
- Shell exit and tab close race: no duplicate exit notice, leaked PTY, or invalid write to a closed session. Task 2 tests this.
- Renderer reload or navigation happens with several tabs open: every owned shell terminates, and a later renderer cannot reuse the old IDs. Task 3 tests this.
- A hidden terminal is shown after panel resize or mode switch: it fits only at positive dimensions and sends a valid PTY resize. Task 5 tests this.

---

## File Structure

- `src/shared/terminal-contract.ts` and `src/shared/terminal-contract.test.ts` — terminal API types, channel names, and strict runtime parsers for requests and events.
- `src/main/terminal-service.ts` and `src/main/terminal-service.test.ts` — injected PTY lifecycle, ownership, data/exit forwarding, and idempotent cleanup.
- `src/main/terminal-pty.ts` — production node-pty factory; the only new module that imports node-pty.
- `src/main/terminal-ipc.ts` and `src/main/terminal-ipc.test.ts` — main-frame authorization, validated working directories, IPC handler registration, and WebContents lifecycle cleanup.
- `src/preload.ts`, `src/preload.test.ts`, and `src/global.d.ts` — expose only typed terminal methods and parsed events beside the existing APIs.
- `src/components/right-workspace.tsx` and `src/components/right-workspace.test.tsx` — panel state, tab list, add menu, close controls, resize handle, and floating surface.
- `src/components/terminal-view.tsx` and `src/components/terminal-view.test.tsx` — xterm instance, fit logic, shell event wiring, exit/restart/error states.
- `src/components/execute-mode.tsx`, `src/components/execute-mode.test.tsx`, `src/App.test.tsx`, and `src/index.css` — place the panel in Execute, preserve its state across modes, and style resize behavior.
- `src/main.ts`, `src/main.test.ts`, `forge.config.ts`, `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` — register/dispose the terminal backend and package the native dependency.

### Task 1: Typed terminal contract and preload surface

**Files:** Create `src/shared/terminal-contract.ts`, `src/shared/terminal-contract.test.ts`; modify `src/preload.ts`, `src/preload.test.ts`, `src/global.d.ts`.

**Interfaces:** Produce `TerminalApi`, `CreateTerminalRequest`, `TerminalRequest`, `TerminalEvent`, `TERMINAL_CHANNELS`, `parseTerminalRequest(unknown): TerminalRequest`, and `parseTerminalEvent(unknown): TerminalEvent`. The API has `create({ id, cwd?, cols, rows })`, `write(id, data)`, `resize(id, cols, rows)`, `close(id)`, and `onEvent(listener): () => void`. `create` resolves `{ shell: string; cwd: string }`. The other methods resolve `void`.

- [ ] **Step 1: Write contract and preload tests that fail.** Use an ID such as `terminal-one` and assert parser rejection of blank IDs, relative paths, zero/NaN/huge dimensions, oversized input, unknown methods, and extra properties. Add to `src/preload.test.ts`:

```ts
const off = surface.terminals.onEvent(listener);
events.emit('fractal:terminal:event', { sender: 'native' }, { type: 'data', id: 'terminal-one', data: 'ready', privateField: 'strip' });
expect(listener).toHaveBeenCalledWith({ type: 'data', id: 'terminal-one', data: 'ready' });
off();
expect(events.listenerCount('fractal:terminal:event')).toBe(0);
```

- [ ] **Step 2: Run `pnpm exec vitest run src/shared/terminal-contract.test.ts src/preload.test.ts`.** Expect a missing contract/API failure.
- [ ] **Step 3: Implement the contract and bridge.** Use one invoke channel and one event channel, with request discriminants `create`, `write`, `resize`, and `close`. Parse into new objects so native/private keys do not cross the preload boundary. Keep dimension limits at 1–500 columns and 1–300 rows, IDs nonblank and at most 128 characters, paths absolute and at most 32,768 characters, and write chunks at most 1 MiB. Reject malformed event objects; event variants are `{type:'data',id,data}` and `{type:'exit',id,exitCode}`. Wire the preload as follows:

```ts
const terminals: TerminalApi = {
  create: (input) => ipcRenderer.invoke(TERMINAL_CHANNELS.invoke, { method: 'create', ...input }),
  write: (id, data) => ipcRenderer.invoke(TERMINAL_CHANNELS.invoke, { method: 'write', id, data }),
  resize: (id, cols, rows) => ipcRenderer.invoke(TERMINAL_CHANNELS.invoke, { method: 'resize', id, cols, rows }),
  close: (id) => ipcRenderer.invoke(TERMINAL_CHANNELS.invoke, { method: 'close', id }),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      try { listener(parseTerminalEvent(payload)); } catch { /* Ignore malformed main events. */ }
    };
    ipcRenderer.on(TERMINAL_CHANNELS.event, handler);
    return () => ipcRenderer.removeListener(TERMINAL_CHANNELS.event, handler);
  },
};
contextBridge.exposeInMainWorld('fractal', { conversations, settings, terminals });
```

- [ ] **Step 4: Run the same two test files and `pnpm exec tsc --noEmit`.** Expect both to pass; update the existing preload surface assertion to include `terminals` and keep all older methods unchanged.

### Task 2: PTY session service and native factory

**Files:** Create `src/main/terminal-service.ts`, `src/main/terminal-service.test.ts`, `src/main/terminal-pty.ts`; modify `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`.

**Interfaces:** Produce `TerminalService` with `create(owner: object, request: CreateTerminalRequest, cwd: string, emit: (event: TerminalEvent) => void): {shell:string;cwd:string}`, `write(owner,id,data)`, `resize(owner,id,cols,rows)`, `close(owner,id)`, `closeOwner(owner)`, and `dispose()`. Inject `PtyFactory` taking `(shell,cwd,cols,rows)` and returning `PtyLike` with `onData`, `onExit`, `write`, `resize`, and `kill`. Produce `createNativePty` in `terminal-pty.ts` and a pure `selectShell(platform, env)` in `terminal-service.ts` so service tests never load the native addon.

- [ ] **Step 1: Write service tests with a fake PTY.** Assert two owners cannot write or close each other's IDs, a duplicate ID is refused, data/exit events retain the ID, shell exit removes the live process, close calls `kill()` once, and exit/close interleaving still calls it at most once. Example test shape:

```ts
const service = new TerminalService(fakeFactory);
service.create(ownerA, { id: 'one', cols: 80, rows: 24 }, '/repo', emit);
expect(() => service.write(ownerB, 'one', 'pwd\r')).toThrow();
service.write(ownerA, 'one', 'pwd\r');
expect(fakePty.write).toHaveBeenCalledWith('pwd\r');
service.close(ownerA, 'one');
service.close(ownerA, 'one');
expect(fakePty.kill).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run `pnpm exec vitest run src/main/terminal-service.test.ts`.** Expect missing service failures.
- [ ] **Step 3: Add dependencies and the minimal implementation.** Run `pnpm add node-pty`; add `node-pty: true` to `allowBuilds` only if pnpm reports its install script was blocked. `selectShell` uses `ComSpec`/`COMSPEC`/`cmd.exe` on Windows and `SHELL`/`/bin/sh` elsewhere. Keep the `node-pty` import in `terminal-pty.ts`, pass `cwd`, `cols`, `rows`, `TERM=xterm-256color`, and other inherited environment values through `pty.spawn` without invoking a shell to build command strings. The service stores each session before returning, removes it on exit, and disposes data/exit listeners on close or exit. Split output longer than the contract's 1 MiB event limit before forwarding. Use the same guarded `release` path from both close and exit:

```ts
export type PtyFactory = (shell: string, cwd: string, cols: number, rows: number) => PtyLike;
export class TerminalService {
  constructor(private readonly factory: PtyFactory) {}
  private readonly sessions = new Map<string, { owner: object; pty: PtyLike }>();
  write(owner: object, id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) throw new Error('Terminal is not owned by this renderer');
    session.pty.write(data);
  }
  close(owner: object, id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.owner !== owner) throw new Error('Terminal is not owned by this renderer');
    this.sessions.delete(id);
    session.pty.kill();
  }
}
```

- [ ] **Step 4: Run the service tests and `pnpm exec tsc --noEmit`.** Check that installing node-pty did not alter the documented Vite/plugin version pins.

### Task 3: Authorized terminal IPC and lifecycle

**Files:** Create `src/main/terminal-ipc.ts`, `src/main/terminal-ipc.test.ts`; modify `src/main.ts`, `src/main.test.ts`.

**Interfaces:** Produce `registerTerminalIpc(service: TerminalService, getWindow: () => BrowserWindow | null): { dispose(): void }`. It registers `TERMINAL_CHANNELS.invoke`, validates the sender and request, chooses/validates cwd for create, forwards `TerminalEvent` to its owning WebContents, and releases all sessions on owner teardown. `main.ts` creates one service and registration at app readiness and disposes them during shutdown.

- [ ] **Step 1: Write IPC tests with fake Electron objects and a fake service.** Cover main-frame-only calls, another WebContents attempting an owned ID, relative/missing/file cwd, default `process.cwd()` with omitted cwd, reloading with two live IDs, repeated cleanup, and sanitization of a PTY spawn error. Example invalid-cwd assertion:

```ts
await expect(invoke(mainFrame, { method: 'create', id: 'one', cwd: '/missing-project', cols: 80, rows: 24 }))
  .rejects.toThrow('Terminal could not start in this folder');
expect(service.create).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run `pnpm exec vitest run src/main/terminal-ipc.test.ts src/main.test.ts`.** Expect missing IPC wiring failures.
- [ ] **Step 3: Implement registration and shutdown wiring.** Follow the existing `registerConversationIpc` sender check: `event.sender === window.webContents`, live sender, and `event.senderFrame === event.sender.mainFrame`. Parse every request with `parseTerminalRequest`. On create, call `stat()` and `realpath()` for the absolute cwd and require a directory before spawning. Track owner lifecycle through `destroyed`, main-frame navigation, and `render-process-gone`; route events only while that owner remains live. Remove the handler and listeners on dispose. Put disposal into `main.ts`'s existing `before-quit` shutdown chain.

```ts
const terminalService = new TerminalService(createNativePty);
const terminalRegistration = registerTerminalIpc(terminalService, () => mainWindowRef);
// In the existing shutdown promise, before app.quit():
terminalRegistration.dispose();
terminalService.dispose();
```

- [ ] **Step 4: Run the two IPC/main tests and `pnpm exec tsc --noEmit`.** Confirm no terminal handler is registered twice when macOS recreates a window.

### Task 4: Floating right workspace and tab controls

**Files:** Create `src/components/right-workspace.tsx`, `src/components/right-workspace.test.tsx`; modify `src/components/execute-mode.tsx`, `src/components/execute-mode.test.tsx`, `src/App.test.tsx`, `src/index.css`.

**Interfaces:** Produce `RightWorkspace({ open, active, projectPath, onOpenChange }: {open:boolean;active:boolean;projectPath:string|null;onOpenChange:(open:boolean)=>void})`. It owns `TerminalTab[]` (`{id,cwd:string|null,label:string}`), selected tab ID, and chosen width. During this shell task, a tab renders an empty `role="tabpanel"` container; Task 5 fills it with `TerminalView`. Execute owns `rightOpen`, passes the selected ref's project path, and keeps the workspace mounted while inactive.

- [ ] **Step 1: Write UI tests for the agreed flow.** Assert initial closed state, toggle opens an empty state, Terminal creates two tabpanel shells, the `+` menu contains disabled Review/Browser/Files and no Side chat, closing the active tab selects a remaining tab, and closing the last tab returns to the empty state. Add a mode-switch test to `src/App.test.tsx` that keeps the tab IDs and open state when returning to Execute. Assert the resize separator responds to ArrowLeft/ArrowRight and cannot shrink a split conversation below 420px.

```tsx
await user.click(screen.getByRole('button', { name: 'Open right panel' }));
await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
expect(screen.getAllByRole('tab', { name: /Terminal/ })).toHaveLength(1);
await user.click(screen.getByRole('button', { name: 'Add tool' }));
expect(screen.getByRole('menuitem', { name: 'Review' }).hasAttribute('data-disabled')).toBe(true);
```

- [ ] **Step 2: Run `pnpm exec vitest run src/components/right-workspace.test.tsx src/components/execute-mode.test.tsx src/App.test.tsx`.** Expect missing workspace behavior.
- [ ] **Step 3: Build the panel shell.** Use the existing Radix dropdown/menu and Button components. Render a `PanelRight` toggle just left of the fixed mode switch, reserve the switch's current 128px width (34px × 3 items + 4px and 14px gaps + 8px padding) in the panel tab bar, and preserve the existing header baseline. Copy the left floating sidebar's `p-2`, `rounded-lg`, `border-sidebar-border`, `bg-sidebar`, and `shadow-sm` treatment. Initial width is `clamp(320px, 40%, 720px)` of the space to the right of the left sidebar. Use a `ResizeObserver` on that space; split only when its width is at least `420 + panelWidth`, otherwise overlay. Clamp drag/keyboard resize to the 320–720px panel range and the 420px conversation floor in split mode. Render each tab's empty `role="tabpanel"` shell now, keep it mounted when hidden, and replace its contents in Task 5. Style focus states and the pointer-drag selection guard in `src/index.css`.

```tsx
<RightWorkspace
  active={active}
  open={rightOpen}
  onOpenChange={setRightOpen}
  projectPath={selectedRef?.projectPath ?? null}
/>
```

- [ ] **Step 4: Run the three UI test files, `pnpm lint`, and `pnpm exec tsc --noEmit`.** Do not open Playwright merely to inspect the clean edit.

### Task 5: Interactive terminal tab renderer

**Files:** Create `src/components/terminal-view.tsx`, `src/components/terminal-view.test.tsx`; modify `src/components/right-workspace.tsx` and its test; add `@xterm/xterm` and `@xterm/addon-fit` to `package.json` and `pnpm-lock.yaml`.

**Interfaces:** Produce `TerminalView({ id, cwd, visible, onShellReady }: {id:string;cwd:string|null;visible:boolean;onShellReady:(shell:string)=>void})`. It mounts one xterm instance and FitAddon, subscribes to `window.fractal.terminals.onEvent` before calling `create`, reports the shell label to its tab, sends input to `write`, fits only at positive visible dimensions, and closes the session on component unmount. `RightWorkspace` passes a snapshot of project path at tab creation and never changes that prop for existing tabs.

- [ ] **Step 1: Write renderer tests with mocked xterm and a fake `TerminalApi`.** Make `create()` emit data synchronously before resolving; assert the prompt reaches xterm. Assert typed input calls `write`, hide/show and ResizeObserver changes invoke `fit` and positive `resize`, shell exit shows status plus Restart, restart reuses the original cwd, failed create shows retry, and unmount closes exactly once. Verify a light/dark media-query change refreshes terminal colors. Verify switching selected conversation before creating a second tab gives the first tab its old cwd and the second the new cwd.

```tsx
const create = vi.fn(async ({ id }: { id: string }) => {
  listener?.({ type: 'data', id, data: '$ ' });
  return { shell: '/bin/sh', cwd: '/repo' };
});
render(<TerminalView id="one" cwd="/repo" visible onShellReady={vi.fn()} />);
await waitFor(() => expect(fakeTerminal.write).toHaveBeenCalledWith('$ '));
```

- [ ] **Step 2: Run `pnpm exec vitest run src/components/terminal-view.test.tsx src/components/right-workspace.test.tsx`.** Expect missing terminal integration.
- [ ] **Step 3: Add xterm dependencies and implement the view.** Run `pnpm add @xterm/xterm @xterm/addon-fit`. Import xterm's CSS once in `terminal-view.tsx`. Create xterm and FitAddon in an effect, open xterm in its DOM node, subscribe first, then call `create({id,cwd:cwd ?? undefined,cols,rows})`; call `onShellReady(result.shell)` when create resolves. Use Geist Mono and the computed `--sidebar`/`--sidebar-foreground` colors for xterm; refresh its theme on `(prefers-color-scheme: dark)` changes, the same signal used by `src/renderer/theme.ts`. Use a `ResizeObserver` and the `visible` prop to call `fit()` and send `resize()` only when `cols > 0 && rows > 0`; re-fit after the panel reappears. Keep the xterm node mounted on tab selection changes. On natural exit, stop writing to the old ID and render exit status plus Restart; on retry, create a fresh process using the same tab ID after the old one has been removed. Clean up observer, input subscription, event listener, xterm object, and terminal session on unmount. In `RightWorkspace`, replace the empty tabpanel contents with `TerminalView` and update the tab label from `onShellReady`.

```ts
const off = window.fractal.terminals.onEvent((event) => {
  if (event.id !== id) return;
  if (event.type === 'data') terminal.write(event.data);
  else setExitCode(event.exitCode);
});
const created = window.fractal.terminals.create({ id, cwd: cwd ?? undefined, cols: 80, rows: 24 });
void created.then((result) => onShellReady(result.shell));
```

- [ ] **Step 4: Run the two renderer test files, `pnpm lint`, and `pnpm exec tsc --noEmit`.** Check that `onEvent` is attached before `create` and no effect dependency re-creates a running shell on visibility changes.

### Task 6: Native packaging and final verification

**Files:** Modify `forge.config.ts` only if the packaged terminal needs explicit native/helper unpacking; modify `src/main/terminal-pty.ts` only if a verified package path issue requires it; update `docs/environment-notes.md` only with an observed build/runtime constraint.

**Interfaces:** No new API. Deliver a development terminal and a packaged local terminal that can start a shell in a selected project, run `pwd`, accept Ctrl+C, resize, close, and leave no process behind.

- [ ] **Step 1: Re-read `docs/environment-notes.md`, then run `pnpm exec vitest run src/shared/terminal-contract.test.ts src/main/terminal-service.test.ts src/main/terminal-ipc.test.ts src/preload.test.ts src/components/right-workspace.test.tsx src/components/terminal-view.test.tsx src/components/execute-mode.test.tsx src/App.test.tsx`.** Expect all focused tests to pass.
- [ ] **Step 2: Run `pnpm lint` and `pnpm exec tsc --noEmit`.** Resolve only failures caused by this feature; preserve the user's pre-existing edits.
- [ ] **Step 3: Run `pnpm package`.** If node-pty's native binary or helper is missing from `out/fractal-*/resources`, set `packagerConfig.asar` to `{ unpackDir: '**/node_modules/node-pty/**' }` or the smallest verified pattern supported by installed `@electron/asar`, then package again. Inspect `app.asar.unpacked` and the packaged runtime rather than assuming a successful build proves the shell can spawn.
- [ ] **Step 4: Smoke-check the packaged app on this host.** Open a selected project, create a terminal, run `pwd`, type a command and interrupt it with Ctrl+C, resize the panel, hide/reopen it, close the tab, and quit. Record whether the terminal worked and which host platform was checked. A browser is unnecessary; this checks the actual native process boundary.
- [ ] **Step 5: Review `git diff --check`, `git status --short`, and the final diff.** Ensure no Claude probe edits were changed by this work, no branch or commit was created, and the packaged output is untracked/ignored as expected.
