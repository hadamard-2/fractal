import { app, BrowserWindow, Menu } from 'electron';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import started from 'electron-squirrel-startup';
import { registerConversationIpc, disposeConversationIpc } from '@/main/agent-ipc';
import { ConversationService } from '@/main/conversation-service';
import { ConversationRegistry } from '@/main/conversation-registry';
import { CodexAppServer, codexSpawner } from '@/main/harness/codex/codex-app-server';
import { CodexAdapter } from '@/main/harness/codex/codex-adapter';
import { ClaudeAdapter } from '@/main/harness/claude/claude-adapter';
import { defaultClaudeExec, detectClaudeRuntime, probeClaude } from '@/main/harness/claude/claude-probe';
import { ClaudeOwnedProcessRegistry } from '@/main/harness/claude/claude-owned-process-registry';
import { configuredExecutable } from '@/main/harness/executable';
import { registerSettingsIpc } from '@/main/settings-ipc';
import { mergeSearchPath, resolveLoginShellPath } from '@/main/shell-environment';
import { registerTerminalIpc } from '@/main/terminal-ipc';
import { TerminalService } from '@/main/terminal-service';
import { createNativePty } from '@/main/terminal-pty';
import type { AgentEnvironment } from '@/shared/settings-contract';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Agents are launched by bare name, so they must be on PATH — but a launch
// from a desktop entry, Finder or the Dock inherits the session's PATH, not
// the one the user's shell sets up. Started at load so the shell's startup
// files run while Electron initialises; agents start only after it settles.
const loginShellPath = resolveLoginShellPath({ platform: process.platform, env: process.env }).then((result) => {
  if (result.path) process.env.PATH = mergeSearchPath(process.env.PATH, result.path);
  return result.resolution;
});
const agentEnvironment = async (): Promise<AgentEnvironment> => ({
  shellPath: await loginShellPath,
  searchPath: (process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
});

// The app draws its own title bar, so the native File/Edit/View menu is removed.
// That also drops the accelerators the menu provided (Ctrl+R reload, Ctrl+Shift+I
// devtools) — `bindWindowShortcuts` below hands the devtools one back.
Menu.setApplicationMenu(null);

// Matches --background in src/index.css (neutral-950) so the OS-drawn window
// buttons sit on the same colour as the title bar we render underneath them.
const TITLE_BAR_BACKGROUND = '#0a0a0a';
const TITLE_BAR_SYMBOL = '#fafafa';

/**
 * Restores the window accelerators that died with the native menu, and adds
 * fullscreen.
 *
 * Scoped to this window's own key handling rather than `globalShortcut`, which
 * would claim these combinations process-wide and steal them from every other
 * app for as long as Fractal is running.
 *
 * Matches on `code` rather than `key` because `key` carries the character the
 * modifiers produce — on macOS, Option+I yields a dead key for composing
 * accented characters, not `'i'` — while `code` names the physical key
 * regardless of modifiers or keyboard layout.
 */
const bindWindowShortcuts = (window: BrowserWindow) => {
  window.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;

    const isMac = process.platform === 'darwin';

    // Ctrl+Shift+I on Windows and Linux, Cmd+Option+I on macOS — the same
    // split Electron's own default menu uses.
    const devTools =
      input.code === 'F12' ||
      (input.code === 'KeyI' &&
        (isMac ? input.meta && input.alt : input.control && input.shift));

    if (devTools) {
      window.webContents.toggleDevTools();
      return;
    }

    // F11 everywhere it means fullscreen; macOS binds F11 to Show Desktop and
    // uses Ctrl+Cmd+F for this instead.
    const fullScreen = isMac
      ? input.code === 'KeyF' && input.control && input.meta
      : input.code === 'F11';

    if (fullScreen) {
      window.setFullScreen(!window.isFullScreen());
    }
  });
};

/**
 * Collapses the layout's title-bar offset while the window is fullscreen.
 *
 * The window is frameless with a `titleBarOverlay`, and the renderer reserves
 * `--titlebar-height` for it. Measured in the running app: fullscreen does not
 * zero `env(titlebar-area-height)` — it makes the variable *unavailable*, so
 * the `2.25rem` fallback in index.css takes over and the app keeps reserving a
 * 36px strip for chrome that is no longer drawn. That empty bar is ours, not
 * the OS's, so it is ours to collapse.
 *
 * `!important` is load-bearing, also measured: stylesheets inserted this way
 * lose to the document's own at equal specificity, so a plain `:root` rule here
 * is silently overridden by the `:root` in index.css and does nothing.
 *
 * A media query would be tidier, but Electron reports `display-mode: browser`
 * in both states, so there is nothing for CSS alone to key off. Injecting from
 * the main process keeps this out of the preload contract: no new IPC surface,
 * no renderer code.
 */
const bindFullScreenChrome = (window: BrowserWindow) => {
  const FULLSCREEN_CSS = ':root { --titlebar-height: 0px !important; }';
  let appliedKey: string | null = null;

  // Serialised: enter/leave can arrive faster than insertCSS resolves, and
  // interleaving them would strand a key and leave the offset stuck.
  let queue = Promise.resolve();

  const sync = (fullScreen: boolean) => {
    queue = queue
      .then(async () => {
        if (window.isDestroyed()) return;
        if (fullScreen && !appliedKey) {
          appliedKey = await window.webContents.insertCSS(FULLSCREEN_CSS);
        } else if (!fullScreen && appliedKey) {
          await window.webContents.removeInsertedCSS(appliedKey);
          appliedKey = null;
        }
      })
      .catch(() => {
        // The window went away mid-flight; nothing left to style.
      });
  };

  window.on('enter-full-screen', () => sync(true));
  window.on('leave-full-screen', () => sync(false));

  // Inserted CSS belongs to the loaded document, so a reload — Vite's, or a
  // manual one — drops it. The old key dies with the old document.
  window.webContents.on('did-finish-load', () => {
    appliedKey = null;
    sync(window.isFullScreen());
  });
};

let mainWindowRef: BrowserWindow | null = null;
let conversationService: ConversationService | undefined;
let codexServer: CodexAppServer | undefined;
let conversationStartup: Promise<void> = Promise.resolve();
const conversationStartupController = new AbortController();
let quitting = false;
let shutdown: Promise<void> | undefined;
let terminalService: TerminalService | undefined;
let terminalRegistration: { dispose(): void } | undefined;

const createWindow = () => {
  /*
    Window and taskbar icon (the dock on Linux/Windows dev runs).

    A plain on-disk path, deliberately not a Vite asset import: this plugin
    version has no `?asset` support, so the import compiled to an inline
    base64 data URI — and `icon` treats its string as a file path, silently
    failing and leaving the stock icon. Development loads the source asset;
    Forge's `extraResource` copies the packaged PNG beside app.asar.

    Installer and desktop-entry icons are separate, per-platform concerns —
    assets/icon.svg is the source of the mark.
  */
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../../assets/icon.png');
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    icon: iconPath,
    // Hide the native title bar but keep the real window controls as an overlay;
    // the renderer draws the bar itself and inset via the titlebar-area-* env vars.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: TITLE_BAR_BACKGROUND,
      symbolColor: TITLE_BAR_SYMBOL,
      height: 36,
    },
    backgroundColor: TITLE_BAR_BACKGROUND,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindowRef = mainWindow;

  bindWindowShortcuts(mainWindow);
  bindFullScreenChrome(mainWindow);

  mainWindow.on('closed', () => {
    mainWindowRef = null;
  });

  mainWindow.maximize();
  return mainWindow;
};

const loadWindow = (mainWindow: BrowserWindow) => {
  if (quitting || shutdown || mainWindow.isDestroyed()) return;
  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
// The IPC handlers are registered exactly once here; createWindow() can run
// again later (see 'activate' below) and must not re-register them.
app.on('ready', () => {
  // First, so the stored theme is applied to `nativeTheme.themeSource` before
  // the window loads and the first frame already has the right scheme.
  const settingsStore = registerSettingsIpc(agentEnvironment);
  terminalService = new TerminalService(createNativePty);
  terminalRegistration = registerTerminalIpc(terminalService, () => mainWindowRef);
  const window = createWindow();
  conversationStartup = (async () => {
    await loginShellPath;
    if (shutdown) return;
    // Read once: a changed location takes effect on the next launch.
    const { agentExecutables } = settingsStore.load();
    const claudeExecutable = configuredExecutable(agentExecutables.claude, 'claude', homedir());
    const codexExecutable = configuredExecutable(agentExecutables.codex, 'codex', homedir());
    codexServer = await CodexAppServer.start(codexSpawner(codexExecutable), conversationStartupController.signal);
    if (shutdown) return;
    const canonicalPath = async (input: string) => realpath(input).catch(() => input);
    const claudeOwnedProcesses = new ClaudeOwnedProcessRegistry();
    const registry = new ConversationRegistry([
      new CodexAdapter(codexServer, { realpath: canonicalPath }),
      new ClaudeAdapter(path.join(homedir(), '.claude', 'projects'), {
        realpath: canonicalPath,
        tempDir: app.getPath('temp'),
        ownedProcesses: claudeOwnedProcesses,
        executable: claudeExecutable,
        probe: () => probeClaude(defaultClaudeExec, claudeExecutable),
        runtime: (ref) => detectClaudeRuntime(ref, { hasOwnedProcess: (candidate) => claudeOwnedProcesses.has(candidate), exec: defaultClaudeExec, executable: claudeExecutable }),
      }),
    ], canonicalPath);
    conversationService = new ConversationService(registry, (event) => registration.emit(event));
    const registration = registerConversationIpc(conversationService, () => mainWindowRef, { attachmentsRoot: path.join(app.getPath('userData'), 'attachments') });
    loadWindow(window);
  })();
  // Startup failures never forward native exception details into the renderer.
  void conversationStartup.catch(() => { if (!shutdown) app.quit(); });
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  if (shutdown) return;
  shutdown = (async () => {
    conversationStartupController.abort();
    terminalRegistration?.dispose();
    terminalService?.dispose();
    await conversationStartup.catch((): void => undefined);
    await disposeConversationIpc();
    await conversationService?.dispose();
    await codexServer?.dispose();
  })().finally(() => { quitting = true; app.quit(); });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    const window = createWindow();
    void conversationStartup.then(() => loadWindow(window)).catch((): void => undefined);
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
