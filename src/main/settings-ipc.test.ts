import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { registerSettingsIpc } from './settings-ipc';
import type { SettingsInvokeRequest } from '@/shared/settings-contract';

const electron = vi.hoisted(() => ({ dir: '', handle: vi.fn(), theme: { themeSource: 'system' }, openPath: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.dir },
  ipcMain: { handle: electron.handle },
  nativeTheme: electron.theme,
  shell: { openPath: electron.openPath },
}));

afterEach(() => {
  electron.handle.mockClear();
  if (electron.dir) rmSync(electron.dir, { recursive: true, force: true });
  electron.dir = '';
});

test('settings IPC saves the selected coding agent for the next launch', async () => {
  electron.dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-ipc-'));
  registerSettingsIpc();
  const handler = electron.handle.mock.calls[0][1] as (_event: unknown, request: SettingsInvokeRequest) => Promise<unknown>;

  await handler(null, { method: 'set', patch: { defaultCodingAgent: 'codex' } });
  expect(JSON.parse(readFileSync(path.join(electron.dir, 'settings.json'), 'utf8')).defaultCodingAgent).toBe('codex');
  expect(await handler(null, { method: 'get' })).toMatchObject({ defaultCodingAgent: 'codex' });
});
