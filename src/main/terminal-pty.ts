import * as pty from 'node-pty';
import type { PtyFactory } from './terminal-service';

export const createNativePty: PtyFactory = (shell, cwd, cols, rows) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  return pty.spawn(shell, [], {
    cwd,
    cols,
    rows,
    name: 'xterm-256color',
    env: { ...env, TERM: 'xterm-256color' },
  });
};
