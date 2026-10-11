import { useCallback, useEffect, useRef, useState } from 'react';
import { CHANGES_POLL_MS, type ChangesResult } from '@/shared/changes-contract';

export type ChangesSnapshot = Extract<ChangesResult, { kind: 'changes' | 'not-a-repo' | 'git-unavailable' }>;

export interface ChangesView {
  snapshot: ChangesSnapshot | null;
  failed: boolean;
  refresh(): void;
}

interface Loaded { root: string; snapshot: ChangesSnapshot | null; failed: boolean }

interface Reader {
  /** `queue` runs the read after the one in flight; otherwise a read in flight absorbs the request. */
  read(queue: boolean): void;
  /** Drops a read queued behind the one in flight. */
  cancelQueued(): void;
  discard(): void;
}

/**
 * Polls the uncommitted changes of `root` while `active` and the window is
 * visible. At most one read per root is in flight, a failed read keeps the last
 * good snapshot, and nothing read for another root, or after unmount, is shown.
 */
export function useChanges(root: string, active: boolean): ChangesView {
  const [loaded, setLoaded] = useState<Loaded>({ root, snapshot: null, failed: false });
  const reader = useRef<Reader | null>(null);

  useEffect(() => {
    let current = true;
    let inFlight = false;
    let queued = false;
    let fingerprint: string | undefined;
    // An update that changes nothing keeps the same state, so an unchanged poll does not re-render.
    const update = (change: Partial<Loaded>) => setLoaded((previous) => (
      (Object.keys(change) as (keyof Loaded)[]).every((key) => previous[key] === change[key]) ? previous : { ...previous, ...change }
    ));
    setLoaded((previous) => (
      previous.root === root && previous.snapshot === null && !previous.failed
        ? previous
        : { root, snapshot: null, failed: false }
    ));
    const apply = (result: ChangesResult) => {
      if (result.kind === 'error') return update({ failed: true });
      if (result.kind === 'unchanged') return update({ failed: false });
      fingerprint = result.kind === 'changes' ? result.fingerprint : undefined;
      update({ snapshot: result, failed: false });
    };
    const read = (queue: boolean) => {
      if (inFlight) {
        if (queue) queued = true;
        return;
      }
      inFlight = true;
      new Promise<ChangesResult>((resolve) => resolve(window.fractal.changes.read(root, fingerprint))).then(
        (result) => { if (current) apply(result); },
        () => { if (current) update({ failed: true }); },
      ).finally(() => {
        inFlight = false;
        if (current && queued) {
          queued = false;
          read(false);
        }
      });
    };
    const self: Reader = { read, cancelQueued: () => { queued = false; }, discard: () => { current = false; } };
    reader.current = self;
    return () => {
      self.discard();
      if (reader.current === self) reader.current = null;
    };
  }, [root]);

  useEffect(() => {
    if (!active) return;
    const visible = () => document.visibilityState === 'visible';
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
      reader.current?.cancelQueued();
    };
    const start = () => {
      if (timer === undefined) timer = setInterval(() => reader.current?.read(false), CHANGES_POLL_MS);
    };
    const onVisibility = () => {
      if (!visible()) return stop();
      reader.current?.read(true);
      start();
    };
    const onFocus = () => { if (visible()) reader.current?.read(true); };
    if (visible()) {
      reader.current?.read(true);
      start();
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [root, active]);

  const refresh = useCallback(() => reader.current?.read(true), []);
  const view: Omit<Loaded, 'root'> = loaded.root === root ? loaded : { snapshot: null, failed: false };
  return { snapshot: view.snapshot, failed: view.failed, refresh };
}
