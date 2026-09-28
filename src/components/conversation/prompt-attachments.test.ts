import { describe, expect, test } from 'vitest';
import { composerFileError, promptAttachments } from '@/components/conversation/prompt-attachments';

const file = (name: string, type: string, size = 10) => ({ name, type, size }) as File;

describe('promptAttachments', () => {
  test('sends disk files by path and pasted images as base64 bytes', () => {
    expect(promptAttachments([
      { type: 'file', url: 'blob:1', mediaType: 'text/markdown', filename: 'notes.md', path: '/repo/notes.md' },
      { type: 'file', url: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png', filename: 'shot.png' },
    ])).toEqual([
      { kind: 'path', path: '/repo/notes.md' },
      { kind: 'bytes', name: 'shot.png', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
    ]);
  });

  test('refuses a pasted image that never became a data URL', () => {
    expect(() => promptAttachments([{ type: 'file', url: 'blob:1', mediaType: 'image/png', filename: 'shot.png' }])).toThrow('Could not read shot.png');
  });
});

describe('composerFileError', () => {
  test('accepts files on disk and pasted supported images', () => {
    expect(composerFileError(file('notes.md', 'text/markdown'), '/repo/notes.md')).toBeNull();
    expect(composerFileError(file('shot.png', 'image/png'), '')).toBeNull();
  });

  test('rejects pathless non-images and oversized images', () => {
    expect(composerFileError(file('clip.bmp', 'image/bmp'), '')).toBe("clip.bmp can't be attached: it has no file on disk and isn't a PNG, JPEG, GIF, or WebP image.");
    expect(composerFileError(file('huge.png', 'image/png', 20 * 1024 * 1024 + 1), '/repo/huge.png')).toBe('huge.png is larger than 20 MiB.');
  });
});
