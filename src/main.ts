import { app, BrowserWindow, Menu } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// The app draws its own title bar, so the native File/Edit/View menu is removed.
// This also drops the accelerators it provided (Ctrl+R reload, Ctrl+Shift+I devtools).
Menu.setApplicationMenu(null);

// Matches --background in src/index.css (neutral-950) so the OS-drawn window
// buttons sit on the same colour as the title bar we render underneath them.
const TITLE_BAR_BACKGROUND = '#0a0a0a';
const TITLE_BAR_SYMBOL = '#fafafa';

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
app.on('ready', createWindow);

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
