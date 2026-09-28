import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readAttachmentPreview } from '@/main/attachments/preview';
import { ATTACHMENT_PREVIEW_TEXT_BYTES } from '@/shared/conversation-contract';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'fractal-preview-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('readAttachmentPreview', () => {
  test('returns text with size and modification time', async () => {
    const file = path.join(directory, 'a.ts');
    await writeFile(file, 'export const a = 1;\n');
    const info = await stat(file);
    await expect(readAttachmentPreview(file)).resolves.toEqual({ kind: 'text', text: 'export const a = 1;\n', truncated: false, size: info.size, modifiedAt: info.mtimeMs });
  });

  test('truncates long text at the cap without breaking a multibyte character', async () => {
    const file = path.join(directory, 'long.txt');
    await writeFile(file, `${'a'.repeat(ATTACHMENT_PREVIEW_TEXT_BYTES - 1)}é and more`);
    const preview = await readAttachmentPreview(file);
    expect(preview).toMatchObject({ kind: 'text', truncated: true });
    expect(preview.kind === 'text' && preview.text).toBe('a'.repeat(ATTACHMENT_PREVIEW_TEXT_BYTES - 1));
  });

  test('returns images as base64 and non-UTF-8 or NUL-containing files as binary', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    await writeFile(path.join(directory, 'a.png'), png);
    await writeFile(path.join(directory, 'nul.bin'), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(path.join(directory, 'latin1.txt'), Buffer.from([0xe9, 0x61]));
    await expect(readAttachmentPreview(path.join(directory, 'a.png'))).resolves.toMatchObject({ kind: 'image', image: { mediaType: 'image/png', data: png.toString('base64') } });
    await expect(readAttachmentPreview(path.join(directory, 'nul.bin'))).resolves.toMatchObject({ kind: 'binary', size: 3 });
    await expect(readAttachmentPreview(path.join(directory, 'latin1.txt'))).resolves.toMatchObject({ kind: 'binary' });
  });

  test('reports a missing file as missing and a directory as binary', async () => {
    await expect(readAttachmentPreview(path.join(directory, 'gone.ts'))).resolves.toEqual({ kind: 'missing' });
    await mkdir(path.join(directory, 'folder'));
    await expect(readAttachmentPreview(path.join(directory, 'folder'))).resolves.toMatchObject({ kind: 'binary' });
  });
});
