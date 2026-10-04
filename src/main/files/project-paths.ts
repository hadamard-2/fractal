import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** A request named a path that leads out of its project. */
export class OutsideProjectError extends Error {
  override name = 'OutsideProjectError';
}

/** Whether `child` is `parent` or inside it. Both must be absolute and normalised. */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Whether a filesystem error means the path does not exist (or something on the way is a file). */
export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Resolves a project-relative path. `lexical` is the path joined onto the
 * project's real root; `real` also follows every symlink. Both must stay
 * inside the root, so neither `../` nor a symlink leads out of the project.
 * Rejects with the filesystem's error (see `isMissing`) when the path does
 * not exist, after the lexical check, so a missing path that escapes is
 * still reported as outside.
 */
export async function resolveInProject(root: string, relative: string): Promise<{ realRoot: string; lexical: string; real: string }> {
  const realRoot = await realpath(root);
  const lexical = path.resolve(realRoot, relative);
  if (!isInside(realRoot, lexical)) throw new OutsideProjectError('Path is outside the project');
  const real = await realpath(lexical);
  if (!isInside(realRoot, real)) throw new OutsideProjectError('Path is outside the project');
  return { realRoot, lexical, real };
}

/** For a file that may not exist: its folder's real path, which must be inside the project, and its own name. */
export async function resolveParentInProject(root: string, relative: string): Promise<{ realParent: string; name: string }> {
  const realRoot = await realpath(root);
  const lexical = path.resolve(realRoot, relative);
  if (lexical === realRoot || !isInside(realRoot, lexical)) throw new OutsideProjectError('Path is outside the project');
  const realParent = await realpath(path.dirname(lexical));
  if (!isInside(realRoot, realParent)) throw new OutsideProjectError('Path is outside the project');
  return { realParent, name: path.basename(lexical) };
}
