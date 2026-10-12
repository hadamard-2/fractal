import { spawn } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { descendantPids, parseProcessTable, readProcessTable } from './process-tree';

describe('descendantPids', () => {
  test('follows parent links through every generation, whatever session a process is in', () => {
    // 100 is the server; 200 is a sandbox wrapper that started its own session; 300 is its command.
    const table = [
      { pid: 1, ppid: 0 }, { pid: 100, ppid: 1 }, { pid: 200, ppid: 100 }, { pid: 300, ppid: 200 },
      { pid: 201, ppid: 100 }, { pid: 400, ppid: 1 }, { pid: 401, ppid: 400 },
    ];
    expect(descendantPids(100, table).sort((a, b) => a - b)).toEqual([200, 201, 300]);
  });

  test('is empty for a process with no children or one missing from the table', () => {
    expect(descendantPids(100, [{ pid: 100, ppid: 1 }])).toEqual([]);
    expect(descendantPids(999, [{ pid: 100, ppid: 1 }])).toEqual([]);
  });

  test('terminates on a parent loop instead of spinning', () => {
    expect(descendantPids(10, [{ pid: 10, ppid: 20 }, { pid: 20, ppid: 10 }])).toEqual([20]);
  });
});

describe('parseProcessTable', () => {
  test('reads pid and ppid columns padded with spaces, skipping lines that are not two numbers', () => {
    expect(parseProcessTable('    1     0\n  412     1\n\n 9001   412 \ngarbage line\n')).toEqual([
      { pid: 1, ppid: 0 }, { pid: 412, ppid: 1 }, { pid: 9001, ppid: 412 },
    ]);
  });
});

describe('readProcessTable', () => {
  test('lists a live child of this process under this process', async () => {
    const child = spawn('sleep', ['5'], { stdio: 'ignore' });
    try {
      const table = await readProcessTable();
      expect(table).toContainEqual({ pid: child.pid, ppid: process.pid });
    } finally {
      child.kill('SIGKILL');
    }
  });
});
