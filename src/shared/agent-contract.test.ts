import { describe, expect, test } from 'vitest';
import {
  CONTRACT_VERSION,
  filesReadFrom,
  isTextPart,
  isWorkPart,
  type Entry,
} from '@/shared/agent-contract';

const entry: Entry = {
  id: 'e1',
  conversationId: 'c1',
  author: 'agent',
  createdAt: 0,
  status: 'complete',
  parts: [
    { id: 'p1', kind: 'text', text: 'hi' },
    { id: 'p2', kind: 'file-read', path: 'a.ts', startedAt: 0, phase: 'done' },
    { id: 'p3', kind: 'file-read', path: 'b.ts', startedAt: 0, phase: 'done' },
    { id: 'p4', kind: 'file-edit', path: 'a.ts', startedAt: 0, phase: 'done' },
  ],
};

describe('agent-contract', () => {
  test('CONTRACT_VERSION is 1', () => {
    expect(CONTRACT_VERSION).toBe(1);
  });

  test('isTextPart / isWorkPart discriminate', () => {
    expect(isTextPart(entry.parts[0])).toBe(true);
    expect(isWorkPart(entry.parts[0])).toBe(false);
    expect(isWorkPart(entry.parts[1])).toBe(true);
  });

  test('filesReadFrom derives read paths, de-duplicated, edits excluded', () => {
    expect(filesReadFrom(entry)).toEqual(['a.ts', 'b.ts']);
  });
});
