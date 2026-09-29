import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  events: [] as string[], windows: [] as Array<{ options: { webPreferences: Record<string, unknown> }; loadFile: ReturnType<typeof vi.fn> }>,
  app: undefined as unknown as EventEmitter & { quit: ReturnType<typeof vi.fn> },
  start: vi.fn(), disposeServer: vi.fn(async () => undefined), disposeService: vi.fn(async () => undefined),
  register: vi.fn(() => ({ emit: vi.fn() })), disposeIpc: vi.fn(async () => undefined),
  registerTerminal: vi.fn(() => ({ dispose: () => { state.events.push('terminal-ipc-dispose'); } })),
  disposeTerminalService: vi.fn(() => { state.events.push('terminal-service-dispose'); }),
  resolveShell: vi.fn(), settings: { agentExecutables: { claude: '', codex: '' } },
  agentEnvironment: undefined as undefined | (() => Promise<unknown>),
  claudeDependencies: undefined as undefined | { executable?: string; probe?: () => Promise<{ message?: string }> },
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  state.app = Object.assign(new EventEmitter(), { quit: vi.fn(), isPackaged: false, getPath: () => '/tmp' });
  class Window extends EventEmitter {
    static getAllWindows() { return state.windows; }
    webContents = new EventEmitter();
    loadFile = vi.fn(() => { state.events.push('load'); });
    maximize = vi.fn();
    isDestroyed() { return false; }
    constructor(public options: { webPreferences: Record<string, unknown> }) { super(); state.windows.push(this); state.events.push('window'); }
  }
  return { app: state.app, BrowserWindow: Window, Menu: { setApplicationMenu: vi.fn() } };
});
vi.mock('electron-squirrel-startup', () => ({ default: false }));
vi.mock('@/main/settings-ipc', () => ({
  registerSettingsIpc: (agentEnvironment: () => Promise<unknown>) => {
    state.events.push('settings'); state.agentEnvironment = agentEnvironment;
    return { load: () => state.settings };
  },
}));
vi.mock('@/main/shell-environment', async (importOriginal) => ({ ...(await importOriginal<object>()), resolveLoginShellPath: state.resolveShell }));
vi.mock('@/main/harness/claude/claude-adapter', () => ({
  ClaudeAdapter: class { provider = 'claude'; constructor(_root: string, dependencies: typeof state.claudeDependencies) { state.claudeDependencies = dependencies; } },
}));
vi.mock('@/main/agent-ipc', () => ({ registerConversationIpc: state.register, disposeConversationIpc: state.disposeIpc }));
vi.mock('@/main/terminal-ipc', () => ({ registerTerminalIpc: state.registerTerminal }));
vi.mock('@/main/terminal-service', () => ({ TerminalService: class { dispose = state.disposeTerminalService; } }));
vi.mock('@/main/terminal-pty', () => ({ createNativePty: vi.fn() }));
vi.mock('@/main/harness/codex/codex-app-server', () => ({ CodexAppServer: { start: state.start }, codexSpawner: (executable: string) => `spawn ${executable}` }));
vi.mock('@/main/conversation-service', () => ({ ConversationService: class { dispose = state.disposeService; constructor() { state.events.push('service'); } } }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); state.events = []; state.windows = [];
  // The electron mock outlives resetModules, so each import would otherwise add another 'ready' handler.
  state.app?.removeAllListeners();
  state.settings = { agentExecutables: { claude: '', codex: '' } }; state.claudeDependencies = undefined;
  state.resolveShell.mockResolvedValue({ resolution: { status: 'resolved', shell: '/bin/zsh' } });
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined); vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
});
afterEach(() => vi.unstubAllGlobals());
describe('main conversation lifecycle', () => {
  test('starts once after the window exists, waits before loading, and disposes before final quit', async () => {
    let started!: (server: unknown) => void;
    state.start.mockImplementation(() => { state.events.push('server'); return new Promise((resolve) => { started = resolve; }); });
    await import('@/main');
    state.app.emit('ready');
    await vi.waitFor(() => expect(state.events).toEqual(['settings', 'window', 'server']));
    expect(state.windows[0].loadFile).not.toHaveBeenCalled();
    started({ dispose: state.disposeServer });
    await vi.waitFor(() => expect(state.windows[0].loadFile).toHaveBeenCalledTimes(1));
    expect(state.register).toHaveBeenCalledTimes(1);
    expect(state.registerTerminal).toHaveBeenCalledTimes(1);
    expect(state.windows[0].options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false });
    const event = { preventDefault: vi.fn() }; state.app.emit('before-quit', event);
    await vi.waitFor(() => expect(state.app.quit).toHaveBeenCalledTimes(1));
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(state.disposeIpc).toHaveBeenCalledTimes(1); expect(state.disposeService).toHaveBeenCalledTimes(1); expect(state.disposeServer).toHaveBeenCalledTimes(1);
    expect(state.events).toContain('terminal-ipc-dispose');
    expect(state.disposeTerminalService).toHaveBeenCalledTimes(1);
    state.app.emit('before-quit', { preventDefault: vi.fn(() => { throw new Error('Final quit must proceed'); }) });
  });
  test('shutdown during server startup disposes the eventual process without registering or loading a renderer', async () => {
    let started!: (server: unknown) => void;
    state.start.mockImplementation(() => new Promise((resolve) => { started = resolve; }));
    await import('@/main'); state.app.emit('ready');
    await vi.waitFor(() => expect(state.start).toHaveBeenCalled());
    state.app.emit('before-quit', { preventDefault: vi.fn() });
    started({ dispose: state.disposeServer });
    await vi.waitFor(() => expect(state.app.quit).toHaveBeenCalledTimes(1));
    expect(state.register).not.toHaveBeenCalled(); expect(state.disposeService).not.toHaveBeenCalled();
    expect(state.disposeServer).toHaveBeenCalledTimes(1); expect(state.windows[0].loadFile).not.toHaveBeenCalled();
  });
  test('shutdown aborts startup that cannot finish by itself and quits after exactly one cleanup', async () => {
    const cancel = vi.fn();
    state.start.mockImplementation((_spawn, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { cancel(); reject(new Error('Codex App Server startup cancelled')); }, { once: true });
    }));
    await import('@/main'); state.app.emit('ready');
    await vi.waitFor(() => expect(state.start).toHaveBeenCalled());
    state.app.emit('before-quit', { preventDefault: vi.fn() });
    state.app.emit('before-quit', { preventDefault: vi.fn() });
    await vi.waitFor(() => expect(state.app.quit).toHaveBeenCalledTimes(1));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(state.disposeIpc).toHaveBeenCalledTimes(1); expect(state.disposeServer).not.toHaveBeenCalled();
    expect(state.register).not.toHaveBeenCalled(); expect(state.windows[0].loadFile).not.toHaveBeenCalled();
  });
});

describe('main agent environment', () => {
  const originalPath = process.env.PATH;
  afterEach(() => { process.env.PATH = originalPath; });

  test('adds the login shell PATH before any agent starts and reports it to Settings', async () => {
    let resolveShell!: (result: unknown) => void;
    state.resolveShell.mockReturnValue(new Promise((resolve) => { resolveShell = resolve; }));
    state.start.mockImplementation(() => { state.events.push(`server with ${process.env.PATH}`); return new Promise(() => undefined); });
    process.env.PATH = '/usr/bin:/bin';
    await import('@/main'); state.app.emit('ready');
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.start).not.toHaveBeenCalled();

    resolveShell({ resolution: { status: 'resolved', shell: '/bin/zsh' }, path: '/home/me/.local/bin:/usr/bin' });
    await vi.waitFor(() => expect(state.events).toContain('server with /usr/bin:/bin:/home/me/.local/bin'));
    await expect(state.agentEnvironment?.()).resolves.toEqual({ shellPath: { status: 'resolved', shell: '/bin/zsh' }, searchPath: ['/usr/bin', '/bin', '/home/me/.local/bin'] });
  });

  test('keeps the inherited PATH and still starts agents when the shell lookup fails', async () => {
    state.resolveShell.mockResolvedValue({ resolution: { status: 'failed', shell: '/bin/zsh', reason: 'timed out after 5000 ms' } });
    process.env.PATH = '/usr/bin:/bin';
    await import('@/main'); state.app.emit('ready');
    await vi.waitFor(() => expect(state.start).toHaveBeenCalled());
    expect(process.env.PATH).toBe('/usr/bin:/bin');
    await expect(state.agentEnvironment?.()).resolves.toMatchObject({ shellPath: { status: 'failed', reason: 'timed out after 5000 ms' } });
  });

  test('launches each agent from its configured location, falling back to its bare name', async () => {
    state.settings = { agentExecutables: { claude: '/nonexistent/fractal-claude', codex: '' } };
    state.start.mockResolvedValue({ dispose: state.disposeServer });
    await import('@/main'); state.app.emit('ready');
    await vi.waitFor(() => expect(state.claudeDependencies).toBeDefined());
    expect(state.start).toHaveBeenCalledWith('spawn codex', expect.anything());
    expect(state.claudeDependencies?.executable).toBe('/nonexistent/fractal-claude');
    await expect(state.claudeDependencies?.probe?.()).resolves.toMatchObject({ message: "Couldn't find /nonexistent/fractal-claude. Check its location in Settings." });
  });

  test('quitting during the shell lookup never starts Codex', async () => {
    let resolveShell!: (result: unknown) => void;
    state.resolveShell.mockReturnValue(new Promise((resolve) => { resolveShell = resolve; }));
    await import('@/main'); state.app.emit('ready');
    state.app.emit('before-quit', { preventDefault: vi.fn() });
    resolveShell({ resolution: { status: 'skipped', reason: 'test' } });
    await vi.waitFor(() => expect(state.app.quit).toHaveBeenCalledTimes(1));
    expect(state.start).not.toHaveBeenCalled();
  });
});
