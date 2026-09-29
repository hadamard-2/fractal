import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { ShellPathResolution } from '@/shared/settings-contract';

export interface LoginShellPathResult {
  resolution: ShellPathResolution;
  /** The shell's PATH, present only when `resolution.status` is 'resolved'. */
  path?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Asks the user's login shell for its PATH.
 *
 * A process launched from a desktop entry, Finder or the Dock inherits the
 * session's PATH: whatever the session's own startup set (a display manager
 * may source ~/.profile; macOS's launchd uses a fixed system default), but not
 * what the user's interactive shell rc files add (nvm, Homebrew, pnpm).
 * Agents and editors found by bare name often live exactly there, so Fractal
 * reads the PATH an interactive login shell would have and adds it to its own.
 *
 * The shell runs in its own session (`detached`) with no stdin, so an rc file
 * can neither take over the terminal Fractal was launched from nor wait on a
 * prompt. Anything the rc files print is ignored: only the text between two
 * random markers counts. A slow or broken rc file costs at most `timeoutMs`.
 */
export function resolveLoginShellPath(options: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<LoginShellPathResult> {
  if (options.platform === 'win32') {
    return Promise.resolve({ resolution: { status: 'skipped', reason: 'not needed on Windows' } });
  }
  const shell = options.env.SHELL?.trim() || '/bin/sh';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const marker = `__FRACTAL_PATH_${randomBytes(8).toString('hex')}__`;
  // printf and printenv are external commands, so this parses in sh, bash, zsh and fish alike.
  const command = `printf '%s' ${marker}; printenv PATH; printf '%s' ${marker}`;

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    const failed = (reason: string): LoginShellPathResult => ({ resolution: { status: 'failed', shell, reason } });
    const finish = (result: LoginShellPathResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(shell, ['-ilc', command], {
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const killGroup = (): void => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      killGroup();
      finish(failed(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const start = stdout.indexOf(marker);
      const end = start === -1 ? -1 : stdout.indexOf(marker, start + marker.length);
      if (end === -1) return;
      const shellPath = stdout.slice(start + marker.length, end).trim();
      finish(shellPath ? { resolution: { status: 'resolved', shell }, path: shellPath } : failed('printed an empty PATH'));
    });
    child.once('error', (error) => finish(failed(`could not start: ${error.message}`)));
    child.once('close', (code, signal) => {
      finish(failed(signal ? `was stopped by ${signal} before printing PATH` : `exited with code ${code} before printing PATH`));
    });
  });
}

/**
 * Adds the shell's PATH entries to the inherited ones. The inherited order is
 * kept and nothing is removed, so a launch from a terminal (whose PATH may be
 * deliberately customised) resolves every command exactly as before.
 */
export function mergeSearchPath(inherited: string | undefined, resolved: string, delimiter: string = path.delimiter): string {
  const entries: string[] = [];
  for (const entry of [...(inherited ?? '').split(delimiter), ...resolved.split(delimiter)]) {
    if (entry && !entries.includes(entry)) entries.push(entry);
  }
  return entries.join(delimiter);
}
