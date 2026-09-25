// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TerminalApi, TerminalEvent } from '@/shared/terminal-contract';
import { TerminalView } from './terminal-view';

const mocks = vi.hoisted(() => ({
  write: vi.fn(), fit: vi.fn(), resize: vi.fn(), open: vi.fn(), dispose: vi.fn(),
  onData: undefined as undefined | ((data: string) => void),
}));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options: Record<string, unknown> = {};
  write = mocks.write; open = mocks.open; dispose = mocks.dispose;
  loadAddon = vi.fn();
  onData(listener: (data: string) => void) { mocks.onData = listener; return { dispose: vi.fn() }; }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = mocks.fit; dispose = vi.fn(); } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

let listener: ((event: TerminalEvent) => void) | undefined;
let create: ReturnType<typeof vi.fn<TerminalApi['create']>>;
let close: ReturnType<typeof vi.fn<TerminalApi['close']>>;
let resize: ReturnType<typeof vi.fn<TerminalApi['resize']>>;
let write: ReturnType<typeof vi.fn<TerminalApi['write']>>;

beforeEach(() => {
  vi.clearAllMocks();
  listener = undefined;
  create = vi.fn<TerminalApi['create']>(async ({ id }) => { listener?.({ type: 'data', id, data: '$ ' }); return { shell: '/bin/sh', cwd: '/repo' }; });
  close = vi.fn<TerminalApi['close']>(async () => undefined);
  resize = vi.fn<TerminalApi['resize']>(async () => undefined);
  write = vi.fn<TerminalApi['write']>(async () => undefined);
  const terminals: TerminalApi = { create, close, resize, write, onEvent: (next) => { listener = next; return () => { listener = undefined; }; } };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { terminals } });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 500, height: 300, x: 0, y: 0, top: 0, left: 0, bottom: 300, right: 500, toJSON: () => undefined });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('receives output emitted before create resolves and writes typed input', async () => {
  const onShellReady = vi.fn();
  render(<TerminalView id="one" cwd="/repo" visible onShellReady={onShellReady} />);
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith('$ '));
  expect(onShellReady).toHaveBeenCalledWith('/bin/sh');
  act(() => mocks.onData?.('pwd\r'));
  expect(write).toHaveBeenCalledWith('one', 'pwd\r');
});

test('fits only when shown, reports positive size, and closes on unmount', async () => {
  const view = render(<TerminalView id="one" cwd="/repo" visible={false} onShellReady={vi.fn()} />);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(mocks.fit).not.toHaveBeenCalled();
  view.rerender(<TerminalView id="one" cwd="/repo" visible onShellReady={vi.fn()} />);
  await waitFor(() => expect(resize).toHaveBeenCalledWith('one', 80, 24));
  view.unmount();
  expect(close).toHaveBeenCalledWith('one');
});

test('shows exit status and restarts in the original directory', async () => {
  const user = userEvent.setup();
  render(<TerminalView id="one" cwd="/repo" visible onShellReady={vi.fn()} />);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  act(() => listener?.({ type: 'exit', id: 'one', exitCode: 130 }));
  expect(screen.getByText(/exited.*130/i)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Restart terminal' }));
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1][0]).toMatchObject({ cwd: '/repo' });
});

test('shows a retry action when a shell cannot start', async () => {
  const user = userEvent.setup();
  create.mockRejectedValueOnce(new Error('private native error'));
  render(<TerminalView id="one" cwd="/repo" visible onShellReady={vi.fn()} />);
  expect(await screen.findByRole('button', { name: 'Retry terminal' })).toBeTruthy();
  expect(screen.queryByText('private native error')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Retry terminal' }));
  expect(create).toHaveBeenCalledTimes(2);
});
