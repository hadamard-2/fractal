import { spawn, type ChildProcess } from 'node:child_process';
import { findOnPath, isExecutableFile } from '@/main/find-on-path';
import { EDITOR_IDS, type EditorId, type EditorInfo, type OpenAction, type OpenResult } from '@/shared/files-contract';

interface EditorSpec { label: string; command: string; args(root: string, file: string, line?: number): string[] }

const at = (file: string, line?: number) => (line === undefined ? file : `${file}:${line}`);
// Given the project folder too, these open the file in the window that has the project open.
const vscodeArgs = (root: string, file: string, line?: number) => [root, '-g', at(file, line)];

/** The editors Fractal can hand a file to, in menu order. */
export const EDITORS: Record<EditorId, EditorSpec> = {
  vscode: { label: 'VS Code', command: 'code', args: vscodeArgs },
  cursor: { label: 'Cursor', command: 'cursor', args: vscodeArgs },
  zed: { label: 'Zed', command: 'zed', args: (_root, file, line) => [at(file, line)] },
  sublime: { label: 'Sublime Text', command: 'subl', args: (_root, file, line) => [at(file, line)] },
};

export interface DetectedEditor extends EditorInfo { executable: string }

/**
 * The editors whose command is on `searchPath`, in menu order. None on
 * Windows: editor launchers there are .cmd batch files, which Node will not
 * start without a shell, and a shell would interpret characters in file names.
 */
export async function detectEditors(platform: NodeJS.Platform, searchPath: string, isExecutable = isExecutableFile): Promise<DetectedEditor[]> {
  if (platform === 'win32') return [];
  const found: DetectedEditor[] = [];
  for (const id of EDITOR_IDS) {
    const { label, command } = EDITORS[id];
    const executable = await findOnPath(command, searchPath, isExecutable);
    if (executable) found.push({ id, label, executable });
  }
  return found;
}

export type Spawn = typeof spawn;
export interface OpenerShell { openPath(path: string): Promise<string>; showItemInFolder(path: string): void }

/** Starts an editor detached from Fractal, with no shell. Resolves true once the process is running. */
function launch(editor: DetectedEditor, root: string, file: string, line: number | undefined, spawnProcess: Spawn): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(editor.executable, EDITORS[editor.id].args(root, file, line), { detached: true, stdio: 'ignore', shell: false });
    } catch { resolve(false); return; }
    child.once('spawn', () => { child.unref(); resolve(true); });
    child.once('error', () => resolve(false));
  });
}

/** Opens `target.file`, already confined to `target.root`, the way the user chose. */
export async function openWith(action: OpenAction, target: { root: string; file: string; line?: number }, deps: { editors: () => Promise<DetectedEditor[]>; shell: OpenerShell; spawnProcess?: Spawn }): Promise<OpenResult> {
  if (action === 'reveal') {
    deps.shell.showItemInFolder(target.file);
    return { ok: true };
  }
  if (action === 'system') {
    return (await deps.shell.openPath(target.file)) === '' ? { ok: true } : { ok: false, message: 'Couldn\'t open this file with the default app' };
  }
  const { label } = EDITORS[action];
  const editor = (await deps.editors()).find((candidate) => candidate.id === action);
  if (!editor) return { ok: false, message: `${label} isn't available` };
  return (await launch(editor, target.root, target.file, target.line, deps.spawnProcess ?? spawn)) ? { ok: true } : { ok: false, message: `Couldn't start ${label}` };
}
