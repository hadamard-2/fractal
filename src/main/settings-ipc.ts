import { app, ipcMain, nativeTheme, shell } from 'electron';
import { SettingsStore } from '@/main/settings-store';
import type { FractalSettings, SettingsInvokeRequest } from '@/shared/settings-contract';
import { SETTINGS_INVOKE_CHANNEL } from '@/shared/settings-contract';

/** IPC payloads are untrusted: keep only keys we know. Values are normalized by the store. */
function sanitizePatch(patch: Partial<FractalSettings>): Partial<FractalSettings> {
  return {
    ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
    ...(patch.defaultCodingAgent !== undefined ? { defaultCodingAgent: patch.defaultCodingAgent } : {}),
    ...(patch.sidebarOrder !== undefined ? { sidebarOrder: patch.sidebarOrder } : {}),
  };
}

/**
 * Settings IPC, plus the one main-process side effect settings have.
 *
 * `nativeTheme.themeSource` is where the stored preference meets Electron:
 * setting it feeds 'light'/'dark'/'system' into the renderer's
 * prefers-color-scheme media query, so the renderer never needs the raw
 * preference — it mirrors the query (see renderer/theme.ts). It is applied at
 * registration, which runs before the first window loads, so the very first
 * frame already has the right scheme and there is no light-mode flash on
 * startup in a dark theme.
 */
export function registerSettingsIpc(): void {
  const store = new SettingsStore(app.getPath('userData'));
  nativeTheme.themeSource = store.load().theme;

  ipcMain.handle(SETTINGS_INVOKE_CHANNEL, async (_e, req: SettingsInvokeRequest) => {
    switch (req.method) {
      case 'get':
        return store.load();
      case 'set': {
        const next = store.save({ ...store.load(), ...sanitizePatch(req.patch) });
        nativeTheme.themeSource = next.theme;
        return next;
      }
      case 'openDataFolder': {
        // shell.openPath resolves with an error string on failure; the folder
        // always exists (the stores mkdir it), so this is best-effort and the
        // message is dropped.
        await shell.openPath(app.getPath('userData'));
        return;
      }
      default: {
        const unreachable: never = req;
        throw new Error(
          `Unrecognized settings invoke method: ${(unreachable as SettingsInvokeRequest).method}`,
        );
      }
    }
  });
}
