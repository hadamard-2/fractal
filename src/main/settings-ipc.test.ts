import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';
import { registerSettingsIpc } from './settings-ipc';
import type { AgentEnvironment, SettingsInvokeRequest } from '@/shared/settings-contract';

const electron = vi.hoisted(() => ({ dir: '', handle: vi.fn(), theme: { themeSource: 'system' }, openPath: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => electron.dir },
  ipcMain: { handle: electron.handle },
  nativeTheme: electron.theme,
  shell: { openPath: electron.openPath },
}));

const unusedEnvironment = async (): Promise<AgentEnvironment> => ({ shellPath: { status: 'skipped', reason: 'test' }, searchPath: [], agents: { claude: { configured: '', lookup: { status: 'unchecked' } }, codex: { configured: '', lookup: { status: 'unchecked' } } } });

const sender = { mainFrame: {} };
const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
const event = (source: { mainFrame: object }, frame: object = source.mainFrame) => ({ sender: source, senderFrame: frame }) as unknown as IpcMainInvokeEvent;
const authorized = event(sender);
type Handler = (event: IpcMainInvokeEvent, request: SettingsInvokeRequest) => Promise<unknown>;

afterEach(() => {
  electron.handle.mockClear();
  if (electron.dir) rmSync(electron.dir, { recursive: true, force: true });
  electron.dir = '';
});

test('settings IPC saves the selected coding agent for the next launch', async () => {
  electron.dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-ipc-'));
  registerSettingsIpc(unusedEnvironment, () => window);
  const handler = electron.handle.mock.calls[0][1] as Handler;

  await handler(authorized, { method: 'set', patch: { defaultCodingAgent: 'codex' } });
  expect(JSON.parse(readFileSync(path.join(electron.dir, 'settings.json'), 'utf8')).defaultCodingAgent).toBe('codex');
  expect(await handler(authorized, { method: 'get' })).toMatchObject({ defaultCodingAgent: 'codex' });
});

test('settings IPC saves agent executable overrides', async () => {
  electron.dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-ipc-'));
  registerSettingsIpc(unusedEnvironment, () => window);
  const handler = electron.handle.mock.calls[0][1] as Handler;

  await handler(authorized, { method: 'set', patch: { agentExecutables: { claude: '/opt/claude', codex: '' } } });
  expect(await handler(authorized, { method: 'get' })).toMatchObject({ agentExecutables: { claude: '/opt/claude', codex: '' } });
});

test('settings IPC reports the environment Fractal searches for agents', async () => {
  electron.dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-ipc-'));
  const environment: AgentEnvironment = { shellPath: { status: 'failed', shell: '/bin/zsh', reason: 'timed out after 5000 ms' }, searchPath: ['/usr/bin', '/bin'], agents: { claude: { configured: '', lookup: { status: 'not-found' } }, codex: { configured: '', lookup: { status: 'found', path: '/usr/bin/codex' } } } };
  registerSettingsIpc(async () => environment, () => window);
  const handler = electron.handle.mock.calls[0][1] as Handler;

  expect(await handler(authorized, { method: 'agentEnvironment' })).toEqual(environment);
});

test('settings IPC saves which agents may offer their dangerous level', async () => {
  electron.dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-ipc-'));
  registerSettingsIpc(unusedEnvironment, () => window);
  const handler = electron.handle.mock.calls[0][1] as Handler;

  await handler(authorized, { method: 'set', patch: { allowDangerousAccess: { claude: true } } });
  expect(JSON.parse(readFileSync(path.join(electron.dir, 'settings.json'), 'utf8')).allowDangerousAccess).toEqual({ claude: true });
  expect(await handler(authorized, { method: 'get' })).toMatchObject({ allowDangerousAccess: { claude: true } });
});

test('settings IPC refuses callers that are not the app window main frame', async () => {
  electron.dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-ipc-'));
  registerSettingsIpc(unusedEnvironment, () => window);
  const handler = electron.handle.mock.calls[0][1] as Handler;
  const patch: SettingsInvokeRequest = { method: 'set', patch: { allowDangerousAccess: { claude: true } } };

  await expect(handler(event({ mainFrame: {} }), patch)).rejects.toThrow('Unauthorized settings sender');
  await expect(handler(event(sender, {}), patch)).rejects.toThrow('Unauthorized settings sender');
  expect(await handler(authorized, { method: 'get' })).toMatchObject({ allowDangerousAccess: {} });
});

test('settings IPC refuses every call when there is no live app window', async () => {
  electron.dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-ipc-'));
  let current: BrowserWindow | null = null;
  registerSettingsIpc(unusedEnvironment, () => current);
  const handler = electron.handle.mock.calls[0][1] as Handler;

  await expect(handler(authorized, { method: 'get' })).rejects.toThrow('Unauthorized settings sender');
  current = { webContents: sender, isDestroyed: () => true } as unknown as BrowserWindow;
  await expect(handler(authorized, { method: 'get' })).rejects.toThrow('Unauthorized settings sender');
});
