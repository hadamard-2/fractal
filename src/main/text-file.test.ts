import { describe, expect, test } from 'vitest';
import { decodeText } from './text-file';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('decodeText', () => {
  test('decodes UTF-8 text', () => {
    expect(decodeText(new TextEncoder().encode('héllo'))).toBe('héllo');
  });

  test('treats a NUL byte or invalid UTF-8 as binary', () => {
    expect(decodeText(bytes(0x61, 0x00, 0x62))).toBeUndefined();
    expect(decodeText(bytes(0xe9, 0x61))).toBeUndefined();
  });

  test('holds back a character cut off at the end only when the bytes were truncated', () => {
    const cut = new TextEncoder().encode('aé').subarray(0, 2);
    expect(decodeText(cut, true)).toBe('a');
    expect(decodeText(cut)).toBeUndefined();
  });
});
