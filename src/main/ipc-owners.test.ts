import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { expect, test, vi } from 'vitest';
import { createOwnerTracker } from './ipc-owners';

class Sender extends EventEmitter {
  mainFrame = {};
  destroyed = false;
  isDestroyed() { return this.destroyed; }
}
function fixture() {
  const sender = new Sender();
  const onRelease = vi.fn();
  const tracker = createOwnerTracker(() => ({ webContents: sender, isDestroyed: () => false }) as unknown as BrowserWindow, onRelease, 'Unauthorized test sender');
  const event = (source: Sender = sender, frame: object = source.mainFrame) => ({ sender: source, senderFrame: frame }) as unknown as IpcMainInvokeEvent;
  return { sender, onRelease, tracker, event };
}

test('authorises only the window\'s main frame and returns one owner per sender', () => {
  const f = fixture();
  expect(f.tracker.authorize(f.event())).toBe(f.tracker.authorize(f.event()));
  expect(() => f.tracker.authorize(f.event(new Sender()))).toThrow('Unauthorized test sender');
  expect(() => f.tracker.authorize(f.event(f.sender, {}))).toThrow('Unauthorized test sender');
});

test('releases an owner once when it navigates away, and not for in-page or subframe navigation', () => {
  const f = fixture();
  const owner = f.tracker.authorize(f.event());
  f.sender.emit('did-start-navigation', {}, 'x', true, true);
  f.sender.emit('did-start-navigation', {}, 'x', false, false);
  expect(f.onRelease).not.toHaveBeenCalled();
  f.sender.emit('did-start-navigation', {}, 'x', false, true);
  f.sender.emit('destroyed');
  expect(f.onRelease).toHaveBeenCalledTimes(1);
  expect(f.onRelease).toHaveBeenCalledWith(owner);
  expect(owner.closed).toBe(true);
  expect(f.tracker.authorize(f.event())).not.toBe(owner);
});

test('dispose releases every owner and refuses later calls', () => {
  const f = fixture();
  f.tracker.authorize(f.event());
  f.tracker.dispose();
  f.tracker.dispose();
  expect(f.onRelease).toHaveBeenCalledTimes(1);
  expect(f.tracker.disposed).toBe(true);
  expect(() => f.tracker.authorize(f.event())).toThrow('Unauthorized test sender');
});
