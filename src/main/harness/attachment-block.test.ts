import { describe, expect, test } from 'vitest';
import { composePromptText, splitAttachmentBlock } from '@/main/harness/attachment-block';

describe('attachment block', () => {
  test('appends non-image paths after a blank line and leaves images out', () => {
    expect(composePromptText({ text: 'Review these', attachments: [{ path: '/repo/a.ts' }, { path: '/tmp/shot.png', image: 'image/png' }, { path: '/repo/b.log' }] }))
      .toBe('Review these\n\n<attachments>\n/repo/a.ts\n/repo/b.log\n</attachments>');
  });

  test('is the block alone without text, and the text alone without files', () => {
    expect(composePromptText({ text: '', attachments: [{ path: '/repo/a.ts' }] })).toBe('<attachments>\n/repo/a.ts\n</attachments>');
    expect(composePromptText({ text: 'Only text', attachments: [{ path: '/tmp/shot.png', image: 'image/png' }] })).toBe('Only text');
    expect(composePromptText({ text: 'Only text' })).toBe('Only text');
  });

  test('splits a trailing well-formed block back into text and paths', () => {
    expect(splitAttachmentBlock('Review these\n\n<attachments>\n/repo/a.ts\n/repo/b.log\n</attachments>')).toEqual({ text: 'Review these', paths: ['/repo/a.ts', '/repo/b.log'] });
    expect(splitAttachmentBlock('<attachments>\n/repo/a.ts\n</attachments>')).toEqual({ text: '', paths: ['/repo/a.ts'] });
  });

  test('leaves malformed, relative, or mid-message blocks as text', () => {
    for (const text of [
      'Review\n\n<attachments>\nrelative/a.ts\n</attachments>',
      'Review\n\n<attachments>\n/repo/a.ts\n</attachments>\n\nand more',
      'Review\n<attachments>\n/repo/a.ts\n</attachments>',
      'Review\n\n<attachments>\n</attachments>',
    ]) expect(splitAttachmentBlock(text)).toEqual({ text, paths: [] });
  });
});
