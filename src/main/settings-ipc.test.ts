import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

afterEach(() => {
  electron.handle.mockClear();
  if (electron.dir) rmSync(electron.dir, { recursive: true, force: true });
  electron.dir = '';
});

test('settings IPC saves the selected coding agent for the next launch', async () => {
  electron.dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-ipc-'));
  registerSettingsIpc(unusedEnvironment);
  const handler = electron.handle.mock.calls[0][1] as (_event: unknown, request: SettingsInvokeRequest) => Promise<unknown>;

  await handler(null, { method: 'set', patch: { defaultCodingAgent: 'codex' } });
  expect(JSON.parse(readFileSync(path.join(electron.dir, 'settings.json'), 'utf8')).defaultCodingAgent).toBe('codex');
  expect(await handler(null, { method: 'get' })).toMatchObject({ defaultCodingAgent: 'codex' });
});

test('settings IPC saves agent executable overrides', async () => {
  electron.dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-ipc-'));
  registerSettingsIpc(unusedEnvironment);
  const handler = electron.handle.mock.calls[0][1] as (_event: unknown, request: SettingsInvokeRequest) => Promise<unknown>;

  await handler(null, { method: 'set', patch: { agentExecutables: { claude: '/opt/claude', codex: '' } } });
  expect(await handler(null, { method: 'get' })).toMatchObject({ agentExecutables: { claude: '/opt/claude', codex: '' } });
});

test('settings IPC reports the environment Fractal searches for agents', async () => {
  electron.dir = mkdtempSync(path.join(tmpdir(), 'fractal-settings-ipc-'));
  const environment: AgentEnvironment = { shellPath: { status: 'failed', shell: '/bin/zsh', reason: 'timed out after 5000 ms' }, searchPath: ['/usr/bin', '/bin'], agents: { claude: { configured: '', lookup: { status: 'not-found' } }, codex: { configured: '', lookup: { status: 'found', path: '/usr/bin/codex' } } } };
  registerSettingsIpc(async () => environment);
  const handler = electron.handle.mock.calls[0][1] as (_event: unknown, request: SettingsInvokeRequest) => Promise<unknown>;

  expect(await handler(null, { method: 'agentEnvironment' })).toEqual(environment);
});
