import { spawn } from 'node:child_process';
import { gitEnvironment, runGit } from '@/main/git';
import type { FileList } from '@/shared/files-contract';

/** Which of `names` in `directory` git ignores; none outside a repository or without git. */
export async function ignoredNames(directory: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const { code, stdout } = await runGit(directory, ['check-ignore', '--stdin', '-z'], `${names.join('\0')}\0`);
  // 0: some are ignored. 1: none are. 128: not a repository. null: git did not start.
  return code === 0 ? new Set(stdout.split('\0').filter(Boolean)) : new Set();
}

/**
 * Tracked files and untracked files that are not ignored, relative to `root`
 * and '/'-separated; undefined outside a repository or without git. Stops
 * reading after `max` paths.
 */
export function listGitFiles(root: string, max: number): Promise<FileList | undefined> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: gitEnvironment() });
    const paths = new Set<string>();
    let pending = '';
    let truncated = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (truncated) return;
      const parts = `${pending}${chunk}`.split('\0');
      pending = parts.pop() ?? '';
      for (const part of parts) {
        if (!part) continue;
        if (paths.size >= max) { truncated = true; child.kill(); return; }
        paths.add(part);
      }
    });
    child.once('error', () => resolve(undefined));
    child.once('close', (code) => resolve(truncated || code === 0 ? { paths: [...paths], truncated } : undefined));
  });
}
