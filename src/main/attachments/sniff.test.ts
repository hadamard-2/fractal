import { describe, expect, test } from 'vitest';
import { sniffImageType } from '@/main/attachments/sniff';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('sniffImageType', () => {
  test('recognises the four supported signatures', () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif');
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe('image/webp');
  });

  test('rejects text, truncated headers, and RIFF files that are not WebP', () => {
    expect(sniffImageType(new TextEncoder().encode('export const a = 1;'))).toBeUndefined();
    expect(sniffImageType(bytes(0x89, 0x50))).toBeUndefined();
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45))).toBeUndefined();
  });
});
