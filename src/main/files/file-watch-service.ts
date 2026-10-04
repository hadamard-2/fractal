import { watch as watchFolder } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FilesEvent } from '@/shared/files-contract';
import { isMissing, OutsideProjectError, resolveInProject, resolveParentInProject } from './project-paths';

/** Watches one folder and reports the name of whatever changed in it, or null when the platform does not say. */
export type DirectoryWatcher = (directory: string, onChange: (name: string | null) => void) => { close(): void };

export const nodeDirectoryWatcher: DirectoryWatcher = (directory, onChange) => {
  const watcher = watchFolder(directory, { persistent: false }, (_type, name) => onChange(name === null ? null : String(name)));
  // A watched folder that disappears errors on some platforms; the watch simply stops reporting.
  watcher.on('error', () => watcher.close());
  return watcher;
};

type Watch = { owner: object; close: () => void; timer?: ReturnType<typeof setTimeout> };

/**
 * Change notifications for the folders and files the renderer is showing. A
 * folder is watched directly. A file is watched through its folder, filtered
 * to its name, because a save that writes a temporary file and renames it
 * over the original replaces the file a direct watch would follow. A burst of
 * changes becomes one event. Each watch belongs to the owner that made it.
 */
export class FileWatchService {
  private readonly watches = new Map<string, Watch>();
  private disposed = false;

  constructor(private readonly watchDirectory: DirectoryWatcher = nodeDirectoryWatcher, private readonly debounceMs = 100) {}

  async watch(owner: object, watchId: string, root: string, relative: string, emit: (event: FilesEvent) => void): Promise<void> {
    if (this.disposed || this.watches.has(watchId)) throw new Error('Watch already exists');
    // Reserved before the first await, so an unwatch during setup is seen.
    const entry: Watch = { owner, close: () => undefined };
    this.watches.set(watchId, entry);
    try {
      const { directory, name } = await this.target(root, relative);
      if (this.watches.get(watchId) !== entry) return;
      const watcher = this.watchDirectory(directory, (changed) => {
        if (name !== undefined && changed !== null && changed !== name) return;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          if (this.watches.get(watchId) === entry) emit({ type: 'changed', watchId });
        }, this.debounceMs);
      });
      entry.close = () => { clearTimeout(entry.timer); watcher.close(); };
    } catch (error) {
      if (this.watches.get(watchId) === entry) this.watches.delete(watchId);
      throw error;
    }
  }

  unwatch(owner: object, watchId: string): void {
    const entry = this.watches.get(watchId);
    if (!entry) return;
    if (entry.owner !== owner) throw new Error('Watch belongs to another owner');
    this.watches.delete(watchId);
    entry.close();
  }

  closeOwner(owner: object): void {
    for (const [watchId, entry] of this.watches) {
      if (entry.owner !== owner) continue;
      this.watches.delete(watchId);
      entry.close();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.watches.values()) entry.close();
    this.watches.clear();
  }

  private async target(root: string, relative: string): Promise<{ directory: string; name?: string }> {
    try {
      const { real } = await resolveInProject(root, relative);
      return (await stat(real)).isDirectory() ? { directory: real } : { directory: path.dirname(real), name: path.basename(real) };
    } catch (error) {
      if (error instanceof OutsideProjectError || !isMissing(error)) throw error;
    }
    // A file that does not exist (yet, or any more) is watched through its folder, so its return is noticed.
    const { realParent, name } = await resolveParentInProject(root, relative);
    return { directory: realParent, name };
  }
}
