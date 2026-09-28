import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readHead, sniffImageType } from '@/main/attachments/sniff';
import type { AgentPrompt, ResolvedAttachment } from '@/main/harness/types';
import { conversationKey, MAX_ATTACHMENT_IMAGE_BYTES, type ConversationImageType, type ConversationRef, type PromptAttachment, type PromptInput } from '@/shared/conversation-contract';

/** A problem with a specific attachment; its message names the file and is shown to the user as-is. */
export class AttachmentError extends Error {
  override name = 'AttachmentError';
}

const EXTENSIONS: Record<ConversationImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const SNIFF_BYTES = 16;
const MAX_ATTACHMENT_IMAGE_MIB = MAX_ATTACHMENT_IMAGE_BYTES / (1024 * 1024);

export async function resolveAttachments(prompt: PromptInput, options: { root: string; ref: ConversationRef }): Promise<AgentPrompt> {
  if (!prompt.attachments?.length) return { text: prompt.text };
  const attachments: ResolvedAttachment[] = [];
  for (const attachment of prompt.attachments) {
    attachments.push(attachment.kind === 'bytes' ? await writePasted(attachment, options) : await inspectPath(attachment.path));
  }
  return { text: prompt.text, attachments };
}

async function writePasted(attachment: Extract<PromptAttachment, { kind: 'bytes' }>, { root, ref }: { root: string; ref: ConversationRef }): Promise<ResolvedAttachment> {
  const bytes = Buffer.from(attachment.data, 'base64');
  const image = sniffImageType(bytes);
  if (!image) throw new AttachmentError(`${attachment.name} is not a PNG, JPEG, GIF, or WebP image`);
  if (bytes.length > MAX_ATTACHMENT_IMAGE_BYTES) throw new AttachmentError(`${attachment.name} is larger than ${MAX_ATTACHMENT_IMAGE_MIB} MiB`);
  const directory = path.join(root, conversationKey(ref).replace(/[^A-Za-z0-9._-]/g, '_'));
  const file = path.join(directory, `${randomUUID()}.${EXTENSIONS[image]}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(file, bytes, { flag: 'wx' });
  } catch {
    throw new AttachmentError(`Could not save ${attachment.name}`);
  }
  return { path: file, image };
}

async function inspectPath(file: string): Promise<ResolvedAttachment> {
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new AttachmentError(`${file} is not a file`);
    size = info.size;
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError(`${file} no longer exists or cannot be read`);
  }
  let image: ConversationImageType | undefined;
  try {
    const head = await readHead(file, SNIFF_BYTES);
    image = sniffImageType(head);
  } catch {
    throw new AttachmentError(`${file} cannot be read`);
  }
  if (image && size > MAX_ATTACHMENT_IMAGE_BYTES) throw new AttachmentError(`${path.basename(file)} is larger than ${MAX_ATTACHMENT_IMAGE_MIB} MiB`);
  return image ? { path: file, image } : { path: file };
}
