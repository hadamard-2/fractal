// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { AttachmentPreviewProvider } from './attachment-preview-context';
import { MessageAttachments } from './message-attachments';
import type { AttachmentPreview, ConversationApi, ConversationRef } from '@/shared/conversation-contract';

const ref: ConversationRef = { provider: 'codex', nativeSessionId: 'attach-test', projectPath: '/work/fractal' };
function install(previews: Record<string, AttachmentPreview>) {
  const previewAttachment = vi.fn<ConversationApi['previewAttachment']>(async (_ref, path) => previews[path] ?? { kind: 'missing' });
  const openAttachment = vi.fn<ConversationApi['openAttachment']>(async () => undefined);
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: { previewAttachment, openAttachment } } });
  return { previewAttachment, openAttachment };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// NOTES has no extension, so it renders as plain text and the assertion is not split across highlight tokens.
test('renders a file chip that opens a text preview with open and reveal actions', async () => {
  const api = install({ '/work/fractal/NOTES': { kind: 'text', text: 'Remember the parser', truncated: false, size: 19, modifiedAt: 1 } });
  render(<AttachmentPreviewProvider conversationRef={ref}><MessageAttachments attachments={[{ path: '/work/fractal/NOTES', kind: 'file' }]} sentAt={5} /></AttachmentPreviewProvider>);
  await userEvent.click(await screen.findByRole('button', { name: 'Preview NOTES' }));
  expect(await screen.findByText('Remember the parser')).toBeTruthy();
  expect(screen.queryByText('Modified since this message was sent')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Show in folder' }));
  expect(api.openAttachment).toHaveBeenCalledWith(ref, '/work/fractal/NOTES', 'reveal');
  await userEvent.click(screen.getByRole('button', { name: 'Open with default app' }));
  expect(api.openAttachment).toHaveBeenCalledWith(ref, '/work/fractal/NOTES', 'open');
});

test('flags a file modified after the message and a truncated preview', async () => {
  install({ '/work/fractal/big.log': { kind: 'text', text: 'start', truncated: true, size: 999_999, modifiedAt: 10 } });
  render(<AttachmentPreviewProvider conversationRef={ref}><MessageAttachments attachments={[{ path: '/work/fractal/big.log', kind: 'file' }]} sentAt={5} /></AttachmentPreviewProvider>);
  await userEvent.click(await screen.findByRole('button', { name: 'Preview big.log' }));
  expect(await screen.findByText('Modified since this message was sent')).toBeTruthy();
  expect(screen.getByText(/Showing the first 256 KiB/)).toBeTruthy();
});

test('marks a missing file and loads an image attachment as a thumbnail', async () => {
  install({ '/tmp/shot.png': { kind: 'image', image: { mediaType: 'image/png', data: 'AAA' }, size: 3, modifiedAt: 1 } });
  render(<AttachmentPreviewProvider conversationRef={ref}><MessageAttachments attachments={[{ path: '/work/fractal/gone.ts', kind: 'file' }, { path: '/tmp/shot.png', kind: 'image' }]} /></AttachmentPreviewProvider>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview gone.ts' }).textContent).toContain('missing'));
  expect(await screen.findByRole('button', { name: 'View image 1 of 1' })).toBeTruthy();
});

test('falls back to a chip when an image attachment cannot be shown', async () => {
  install({});
  render(<AttachmentPreviewProvider conversationRef={ref}><MessageAttachments attachments={[{ path: '/tmp/gone.png', kind: 'image' }]} /></AttachmentPreviewProvider>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview gone.png' }).textContent).toContain('missing'));
});
