import { open } from 'node:fs/promises';
import type { ConversationImageType } from '@/shared/conversation-contract';

/** The supported image type a file's leading bytes declare, if any; the renderer's claimed type is never trusted. */
export function sniffImageType(bytes: Uint8Array): ConversationImageType | undefined {
  const starts = (signature: readonly number[], offset = 0) =>
    bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return undefined;
}

/** Reads up to `bytes` leading bytes of `file`, opening and closing it for this read alone. */
export async function readHead(file: string, bytes: number): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(bytes), 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
