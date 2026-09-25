import type { CreateTerminalRequest, TerminalEvent } from '@/shared/terminal-contract';

interface Disposable { dispose(): void }
export interface PtyLike {
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export type PtyFactory = (shell: string, cwd: string, cols: number, rows: number) => PtyLike;

export function selectShell(platform: string, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') return env.ComSpec?.trim() || env.COMSPEC?.trim() || 'cmd.exe';
  return env.SHELL?.trim() || '/bin/sh';
}

type Session = { owner: object; pty: PtyLike; subscriptions: Disposable[] };

export class TerminalService {
  private readonly sessions = new Map<string, Session>();
  private disposed = false;

  constructor(private readonly factory: PtyFactory) {}

  create(owner: object, request: CreateTerminalRequest, cwd: string, emit: (event: TerminalEvent) => void): { shell: string; cwd: string } {
    if (this.disposed || this.sessions.has(request.id)) throw new Error('Terminal already exists');
    const shell = selectShell(process.platform, process.env);
    const pty = this.factory(shell, cwd, request.cols, request.rows);
    const session: Session = { owner, pty, subscriptions: [] };
    this.sessions.set(request.id, session);
    const release = () => {
      if (this.sessions.get(request.id) !== session) return false;
      this.sessions.delete(request.id);
      for (const subscription of session.subscriptions) subscription.dispose();
      return true;
    };
    session.subscriptions.push(pty.onData((chunk) => {
      if (this.sessions.get(request.id) !== session) return;
      for (let start = 0; start < chunk.length; start += 1_048_576) {
        emit({ type: 'data', id: request.id, data: chunk.slice(start, start + 1_048_576) });
      }
    }));
    session.subscriptions.push(pty.onExit(({ exitCode }) => {
      if (release()) emit({ type: 'exit', id: request.id, exitCode });
    }));
    return { shell, cwd };
  }

  private owned(owner: object, id: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) throw new Error('Terminal is not owned by this renderer');
    return session;
  }

  write(owner: object, id: string, data: string): void { this.owned(owner, id).pty.write(data); }
  resize(owner: object, id: string, cols: number, rows: number): void { this.owned(owner, id).pty.resize(cols, rows); }

  close(owner: object, id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.owner !== owner) throw new Error('Terminal is not owned by this renderer');
    this.sessions.delete(id);
    for (const subscription of session.subscriptions) subscription.dispose();
    session.pty.kill();
  }

  closeOwner(owner: object): void {
    for (const [id, session] of [...this.sessions]) if (session.owner === owner) this.close(owner, id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, session] of [...this.sessions]) this.close(session.owner, id);
  }
}
