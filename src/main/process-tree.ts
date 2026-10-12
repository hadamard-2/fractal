import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface ProcessTableRow { pid: number; ppid: number }

/**
 * Every process below `root`, found by parent links alone. An agent's
 * commands can start their own session and process group, so only the parent
 * chain still connects them to the agent; it holds while the agent is alive.
 */
export function descendantPids(root: number, table: ProcessTableRow[]): number[] {
  const children = new Map<number, number[]>();
  for (const { pid, ppid } of table) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const found = new Set<number>();
  const pending = [root];
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent) ?? []) {
      if (child === root || found.has(child)) continue;
      found.add(child);
      pending.push(child);
    }
  }
  return [...found];
}

export function parseProcessTable(text: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]) });
  }
  return rows;
}

/** The system's processes with their parents, from `ps` (the same flags work on Linux and macOS). */
export async function readProcessTable(): Promise<ProcessTableRow[]> {
  const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { maxBuffer: 8 * 1024 * 1024 });
  return parseProcessTable(stdout);
}
