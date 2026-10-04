import { readFile, stat } from 'node:fs/promises';
import { sniffImageType, readHead } from '@/main/attachments/sniff';
import { decodeText } from '@/main/text-file';
import { ATTACHMENT_PREVIEW_TEXT_BYTES, MAX_ATTACHMENT_IMAGE_BYTES, type AttachmentPreview } from '@/shared/conversation-contract';

/** The file as it is now: an image, the leading text, or only its size when it is neither. */
export async function readAttachmentPreview(file: string): Promise<AttachmentPreview> {
  let info;
  try { info = await stat(file); } catch { return { kind: 'missing' }; }
  const meta = { size: info.size, modifiedAt: info.mtimeMs };
  if (!info.isFile()) return { kind: 'binary', ...meta };
  const sample = await readHead(file, Math.min(info.size, ATTACHMENT_PREVIEW_TEXT_BYTES));
  const image = sniffImageType(sample);
  if (image) {
    if (info.size > MAX_ATTACHMENT_IMAGE_BYTES) return { kind: 'binary', ...meta };
    const data = await readFile(file);
    return { kind: 'image', image: { mediaType: image, data: data.toString('base64') }, ...meta };
  }
  const truncated = info.size > ATTACHMENT_PREVIEW_TEXT_BYTES;
  const text = decodeText(sample, truncated);
  return text === undefined ? { kind: 'binary', ...meta } : { kind: 'text', text, truncated, ...meta };
}

