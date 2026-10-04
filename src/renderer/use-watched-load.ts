import { useEffect, useState } from 'react';

export type Watched<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'failed' };

/**
 * Loads `path` in `root`, and loads it again whenever main reports a change to
 * it, for as long as the caller is mounted. `load` must be stable. A slower
 * earlier response never overwrites a later one, and a reload keeps showing
 * the previous value until the new one arrives.
 */
export function useWatchedLoad<T>(root: string, path: string, load: (root: string, path: string) => Promise<T>): Watched<T> {
  const [state, setState] = useState<Watched<T>>({ status: 'loading' });
  useEffect(() => {
    const files = window.fractal.files;
    const watchId = crypto.randomUUID();
    let current = true;
    let latest = 0;
    const refresh = () => {
      const request = ++latest;
      load(root, path).then(
        (value) => { if (current && request === latest) setState({ status: 'ready', value }); },
        () => { if (current && request === latest) setState({ status: 'failed' }); },
      );
    };
    setState({ status: 'loading' });
    const off = files.onEvent((event) => { if (event.watchId === watchId) refresh(); });
    const watching = files.watch(watchId, root, path).catch((): void => undefined);
    refresh();
    return () => {
      current = false;
      off();
      // Main registers a watch only after it has checked the root, so an unwatch sent before that finishes would find nothing and the watch would outlive this component.
      void watching.then(() => files.unwatch(watchId)).catch((): void => undefined);
    };
  }, [root, path, load]);
  return state;
}
