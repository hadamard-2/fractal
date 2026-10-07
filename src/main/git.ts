import { spawn } from 'node:child_process';

// Read at call time: main adds the login shell's PATH after this module loads.
// GIT_OPTIONAL_LOCKS=0 keeps these read-only queries from taking the index lock.
export const gitEnvironment = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0' });

/** Runs git in `cwd`. Resolves with a null code when git could not be started. */
export function runGit(cwd: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', cwd, ...args], { shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: gitEnvironment() });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.once('error', () => resolve({ code: null, stdout: '' }));
    child.once('close', (code) => resolve({ code, stdout }));
    // git can exit before reading all of stdin; the exit code still says what happened.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
}

export function streamGitLines(cwd: string, args: string[], onLine: (line: string) => boolean): Promise<{ code: number | null; stopped: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', cwd, ...args], { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: gitEnvironment() });
    let pending = '';
    let stopped = false;
    let resolved = false;

    const finish = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      resolve({ code, stopped });
    };

    const stop = () => {
      stopped = true;
      child.kill();
    };

    const deliver = (line: string) => {
      if (stopped) return;
      if (!onLine(line)) stop();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      const parts = `${pending}${chunk}`.split('\n');
      pending = parts.pop() ?? '';
      for (const part of parts) {
        deliver(part);
        if (stopped) return;
      }
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => {
      if (!stopped && pending !== '') deliver(pending);
      finish(code);
    });
  });
}
