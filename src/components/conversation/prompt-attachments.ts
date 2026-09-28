import type { PromptInputMessage } from '@/components/ai-elements/prompt-input';
import { isConversationImageType, MAX_ATTACHMENT_IMAGE_BYTES, type PromptAttachment } from '@/shared/conversation-contract';

/** Why a file cannot be attached, or null when it can. */
export function composerFileError(file: File, path: string): string | null {
  const image = isConversationImageType(file.type);
  if (!path && !image) return `${file.name} can't be attached: it has no file on disk and isn't a PNG, JPEG, GIF, or WebP image.`;
  if (image && file.size > MAX_ATTACHMENT_IMAGE_BYTES) return `${file.name} is larger than ${MAX_ATTACHMENT_IMAGE_BYTES / (1024 * 1024)} MiB.`;
  return null;
}

/** Files on disk go by path; pasted images go as the base64 payload of their data URL. */
export function promptAttachments(files: PromptInputMessage['files']): PromptAttachment[] {
  return files.map((file): PromptAttachment => {
    if (file.path) return { kind: 'path', path: file.path };
    const name = file.filename ?? 'image';
    const comma = file.url.indexOf(',');
    if (!file.url.startsWith('data:') || comma === -1 || !isConversationImageType(file.mediaType)) throw new Error(`Could not read ${name}`);
    return { kind: 'bytes', name, mediaType: file.mediaType, data: file.url.slice(comma + 1) };
  });
}
