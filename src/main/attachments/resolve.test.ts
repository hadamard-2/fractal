import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AttachmentError, resolveAttachments } from '@/main/attachments/resolve';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ref = { provider: 'claude' as const, nativeSessionId: 'session-1', projectPath: '/repo' };
let directory: string;
let root: string;

beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'fractal-attach-')); root = path.join(directory, 'attachments'); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('resolveAttachments', () => {
  test('passes a text-only prompt through without an attachments key', async () => {
    await expect(resolveAttachments({ text: 'Hi' }, { root, ref })).resolves.toEqual({ text: 'Hi' });
  });

  test('writes pasted bytes under the conversation folder and marks them by sniffed type', async () => {
    const result = await resolveAttachments({ text: '', attachments: [{ kind: 'bytes', name: 'shot.png', mediaType: 'image/jpeg', data: PNG.toString('base64') }] }, { root, ref });
    const [attachment] = result.attachments ?? [];
    expect(attachment.image).toBe('image/png');
    expect(path.dirname(attachment.path)).toBe(path.join(root, 'claude_session-1'));
    expect(attachment.path.endsWith('.png')).toBe(true);
    expect(await readFile(attachment.path)).toEqual(PNG);
  });

  test('rejects pasted bytes that are not a supported image', async () => {
    await expect(resolveAttachments({ text: '', attachments: [{ kind: 'bytes', name: 'shot.png', mediaType: 'image/png', data: Buffer.from('hello').toString('base64') }] }, { root, ref }))
      .rejects.toThrow(new AttachmentError('shot.png is not a PNG, JPEG, GIF, or WebP image'));
    await expect(readdir(root)).rejects.toThrow();
  });

  test('keeps disk paths in place, sniffing images and leaving other files unmarked', async () => {
    const image = path.join(directory, 'diagram.png'); const notes = path.join(directory, 'notes.md');
    await writeFile(image, PNG); await writeFile(notes, '# Notes');
    const result = await resolveAttachments({ text: 'Look', attachments: [{ kind: 'path', path: notes }, { kind: 'path', path: image }] }, { root, ref });
    expect(result).toEqual({ text: 'Look', attachments: [{ path: notes }, { path: image, image: 'image/png' }] });
  });

  test('names the file when a path is missing or is a directory', async () => {
    const missing = path.join(directory, 'gone.ts'); const folder = path.join(directory, 'folder');
    await mkdir(folder);
    await expect(resolveAttachments({ text: 'x', attachments: [{ kind: 'path', path: missing }] }, { root, ref })).rejects.toThrow(`${missing} no longer exists or cannot be read`);
    await expect(resolveAttachments({ text: 'x', attachments: [{ kind: 'path', path: folder }] }, { root, ref })).rejects.toThrow(`${folder} is not a file`);
  });
});
