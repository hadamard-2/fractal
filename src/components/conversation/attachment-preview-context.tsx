import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AttachmentOpenAction, AttachmentPreview, ConversationRef } from '@/shared/conversation-contract';

type AttachmentPreviews = {
  /** The cached preview, or a fresh read when fresh is set (the dialog shows the file as it is now). */
  load(path: string, fresh?: boolean): Promise<AttachmentPreview>;
  open(path: string, action: AttachmentOpenAction): Promise<void>;
};

const AttachmentPreviewContext = createContext<AttachmentPreviews | null>(null);

export function AttachmentPreviewProvider({ conversationRef, children }: { conversationRef: ConversationRef; children: ReactNode }) {
  const value = useMemo<AttachmentPreviews>(() => {
    // Virtual rows remount as they scroll; the cache keeps that from re-reading files.
    const cache = new Map<string, Promise<AttachmentPreview>>();
    return {
      load(path, fresh = false) {
        const cached = cache.get(path);
        if (cached && !fresh) return cached;
        const request = window.fractal.conversations.previewAttachment(conversationRef, path);
        cache.set(path, request);
        request.catch(() => { if (cache.get(path) === request) cache.delete(path); });
        return request;
      },
      open: (path, action) => window.fractal.conversations.openAttachment(conversationRef, path, action),
    };
  }, [conversationRef]);
  return <AttachmentPreviewContext.Provider value={value}>{children}</AttachmentPreviewContext.Provider>;
}

export function useAttachmentPreviews(): AttachmentPreviews {
  const context = useContext(AttachmentPreviewContext);
  if (!context) throw new Error('useAttachmentPreviews must be used within AttachmentPreviewProvider');
  return context;
}
