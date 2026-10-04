import { findOnPath, isExecutableFile, type IsExecutable } from '@/main/find-on-path';
import type { AgentLookup } from '@/shared/settings-contract';

/**
 * Where `executable` (a path, or a bare name looked up on `searchPath`) resolves to. This only checks for an executable file; it can't tell whether the agent runs. Unchecked on Windows, where launchers resolve through PATHEXT.
 */
export async function lookUpAgent(executable: string, platform: NodeJS.Platform, searchPath: string, isExecutable: IsExecutable = isExecutableFile): Promise<AgentLookup> {
  if (platform === 'win32') return { status: 'unchecked' };
  const found = /[/\\]/.test(executable)
    ? ((await isExecutable(executable)) ? executable : null)
    : await findOnPath(executable, searchPath, isExecutable);
  return found ? { status: 'found', path: found } : { status: 'not-found' };
}
