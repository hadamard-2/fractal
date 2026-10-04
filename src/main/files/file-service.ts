import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeText } from '@/main/text-file';
import { FILE_LIST_MAX_ENTRIES, FILE_VIEW_MAX_BYTES, type FileContent, type FileEntry, type FileList } from '@/shared/files-contract';
import { ignoredNames, listGitFiles } from './git';
import { isInside, isMissing, OutsideProjectError, resolveInProject } from './project-paths';

const compareEntries = (a: FileEntry, b: FileEntry): number =>
  a.kind === b.kind
    ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    : a.kind === 'directory' ? -1 : 1;

/** A folder's entries, folders first; `.git` is never listed. */
export async function listDirectory(root: string, relative: string): Promise<FileEntry[]> {
  const { realRoot, real: directory } = await resolveInProject(root, relative);
  const dirents = (await readdir(directory, { withFileTypes: true })).filter((dirent) => dirent.name !== '.git');
  const entries = await Promise.all(dirents.map(async (dirent): Promise<Omit<FileEntry, 'ignored'>> => {
    if (!dirent.isSymbolicLink()) {
      return { name: dirent.name, kind: dirent.isDirectory() ? 'directory' : 'file', symlink: false, outside: false };
    }
    try {
      const target = await realpath(path.join(directory, dirent.name));
      return { name: dirent.name, kind: (await stat(target)).isDirectory() ? 'directory' : 'file', symlink: true, outside: !isInside(realRoot, target) };
    } catch {
      // A broken link: listed as a file, which then reads as missing.
      return { name: dirent.name, kind: 'file', symlink: true, outside: false };
    }
  }));
  const ignored = await ignoredNames(directory, entries.map((entry) => entry.name));
  return entries.map((entry) => ({ ...entry, ignored: ignored.has(entry.name) })).sort(compareEntries);
}

/** A file's contents for the viewer, or why there are none. Throws only for a path outside the project. */
export async function readProjectFile(root: string, relative: string): Promise<FileContent> {
  try {
    const { real } = await resolveInProject(root, relative);
    const info = await stat(real);
    if (!info.isFile()) return { kind: 'unreadable' };
    if (info.size > FILE_VIEW_MAX_BYTES) return { kind: 'too-large', size: info.size };
    const bytes = await readFile(real);
    // It may have grown since the stat.
    if (bytes.length > FILE_VIEW_MAX_BYTES) return { kind: 'too-large', size: bytes.length };
    const content = decodeText(bytes);
    return content === undefined ? { kind: 'binary', size: bytes.length } : { kind: 'text', content, size: bytes.length };
  } catch (error) {
    if (error instanceof OutsideProjectError) throw error;
    return isMissing(error) ? { kind: 'missing' } : { kind: 'unreadable' };
  }
}

/** Every file the filter searches: git's list in a repository, otherwise a capped walk. */
export async function listProjectFiles(root: string, max = FILE_LIST_MAX_ENTRIES): Promise<FileList> {
  const realRoot = await realpath(root);
  return (await listGitFiles(realRoot, max)) ?? walkFiles(realRoot, max);
}

async function walkFiles(root: string, max: number): Promise<FileList> {
  const paths: string[] = [];
  const folders = [''];
  for (let index = 0; index < folders.length; index++) {
    const folder = folders[index];
    let dirents;
    try { dirents = await readdir(path.join(root, folder), { withFileTypes: true }); } catch { continue; }
    for (const dirent of dirents) {
      if (dirent.name === '.git') continue;
      const child = folder ? `${folder}/${dirent.name}` : dirent.name;
      // Symlinked folders are not followed, so a link cycle cannot loop the walk.
      if (dirent.isDirectory()) { folders.push(child); continue; }
      if (paths.length >= max) return { paths, truncated: true };
      paths.push(child);
    }
  }
  return { paths, truncated: false };
}
