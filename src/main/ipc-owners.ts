import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';

export type IpcOwner = { sender: WebContents; closed: boolean; detach: () => void };

/**
 * Tracks the renderers that own main-process resources over one IPC surface.
 * An owner is released exactly once, when its WebContents is destroyed,
 * navigates its main frame to a new document, or crashes; `onRelease` then
 * frees what it owned. Only the app window's main frame is authorised.
 */
export function createOwnerTracker(getWindow: () => BrowserWindow | null, onRelease: (owner: IpcOwner) => void, unauthorizedMessage: string) {
  const owners = new Map<WebContents, IpcOwner>();
  let disposed = false;

  const release = (owner: IpcOwner) => {
    if (owner.closed) return;
    owner.closed = true;
    owner.detach();
    owners.delete(owner.sender);
    onRelease(owner);
  };

  const ownerFor = (sender: WebContents): IpcOwner => {
    const known = owners.get(sender);
    if (known) return known;
    const owner: IpcOwner = { sender, closed: false, detach: () => undefined };
    const destroyed = () => release(owner);
    const navigated = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) release(owner);
    };
    const crashed = () => release(owner);
    sender.on('destroyed', destroyed);
    sender.on('did-start-navigation', navigated);
    sender.on('render-process-gone', crashed);
    owner.detach = () => {
      sender.removeListener('destroyed', destroyed);
      sender.removeListener('did-start-navigation', navigated);
      sender.removeListener('render-process-gone', crashed);
    };
    owners.set(sender, owner);
    return owner;
  };

  return {
    authorize(event: IpcMainInvokeEvent): IpcOwner {
      const window = getWindow();
      if (disposed || !window || window.isDestroyed() || event.sender !== window.webContents || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
        throw new Error(unauthorizedMessage);
      }
      return ownerFor(event.sender);
    },
    release,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const owner of [...owners.values()]) release(owner);
    },
    get disposed() { return disposed; },
  };
}
