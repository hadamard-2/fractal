import { app, BrowserWindow, Menu } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { registerAgentIpc } from '@/main/agent-ipc';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// The app draws its own title bar, so the native File/Edit/View menu is removed.
// That also drops the accelerators the menu provided (Ctrl+R reload, Ctrl+Shift+I
// devtools) — `bindDevToolsShortcut` below hands the devtools one back.
Menu.setApplicationMenu(null);

// Matches --background in src/index.css (neutral-950) so the OS-drawn window
// buttons sit on the same colour as the title bar we render underneath them.
const TITLE_BAR_BACKGROUND = '#0a0a0a';
const TITLE_BAR_SYMBOL = '#fafafa';

/**
 * Restores the devtools accelerator that died with the native menu.
 *
 * Scoped to this window's own key handling rather than `globalShortcut`, which
 * would claim the combination process-wide and steal it from every other app
 * for as long as Fractal is running.
 *
 * Matches on `code` rather than `key` because `key` carries the character the
 * modifiers produce — on macOS, Option+I yields a dead key for composing
 * accented characters, not `'i'` — while `code` names the physical key
 * regardless of modifiers or keyboard layout.
 */
const bindDevToolsShortcut = (window: BrowserWindow) => {
  window.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;

    // Ctrl+Shift+I on Windows and Linux, Cmd+Option+I on macOS — the same
    // split Electron's own default menu uses.
    const chord =
      input.code === 'KeyI' &&
      (process.platform === 'darwin'
        ? input.meta && input.alt
        : input.control && input.shift);

    if (input.code === 'F12' || chord) {
      window.webContents.toggleDevTools();
    }
  });
};

let mainWindowRef: BrowserWindow | null = null;

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
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
    },
  });

  mainWindowRef = mainWindow;

  bindDevToolsShortcut(mainWindow);

  mainWindow.on('closed', () => {
    mainWindowRef = null;
  });

  mainWindow.maximize();

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
  registerAgentIpc(() => mainWindowRef);
  createWindow();
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
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
