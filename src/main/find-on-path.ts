import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

export type IsExecutable = (file: string) => Promise<boolean>;

export const isExecutableFile: IsExecutable = async (file) => {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch { return false; }
};

/**
 * The first executable named `command` in the absolute entries of `searchPath`, or null. Relative entries are skipped, so nothing inside the folder Fractal happens to run from is ever chosen.
 */
export async function findOnPath(command: string, searchPath: string, isExecutable: IsExecutable = isExecutableFile): Promise<string | null> {
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}
