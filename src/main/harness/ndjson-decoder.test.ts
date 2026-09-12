import { describe, expect, test } from 'vitest';
import { NdjsonDecoder } from '@/main/harness/ndjson-decoder';

describe('NdjsonDecoder', () => {
  test('decodes split and batched records in order', () => {
    const decoder = new NdjsonDecoder<Record<string, unknown>>();

    expect(decoder.push('{"id":1}\n{"id"')).toEqual([{ ok: true, value: { id: 1 } }]);
    expect(decoder.push(':2}\n')).toEqual([{ ok: true, value: { id: 2 } }]);
  });

  test('preserves a UTF-8 character split across byte chunks', () => {
    const decoder = new NdjsonDecoder<Record<string, string>>();
    const bytes = Buffer.from('{"text":"café"}\n', 'utf8');
    const accent = Buffer.from('é', 'utf8');
    const accentStart = bytes.indexOf(accent);

    expect(decoder.push(bytes.subarray(0, accentStart + 1))).toEqual([]);
    expect(decoder.push(bytes.subarray(accentStart + 1))).toEqual([
      { ok: true, value: { text: 'café' } },
    ]);
  });

  test('skips blank records and supports CRLF lines', () => {
    const decoder = new NdjsonDecoder<{ id: number }>();

    expect(decoder.push('\n  \r\n{"id":1}\r\n\t\n')).toEqual([
      { ok: true, value: { id: 1 } },
    ]);
  });

  test('quarantines malformed lines and marks an incomplete tail for retry', () => {
    const decoder = new NdjsonDecoder<Record<string, unknown>>();

    expect(decoder.push('{bad}\n')).toEqual([{ ok: false, raw: '{bad}', error: 'Invalid JSON record' }]);
    decoder.push('{"id":3');
    expect(decoder.finish()).toEqual({ kind: 'incomplete', raw: '{"id":3' });
  });

  test('reports an empty finish when only complete or blank lines were received', () => {
    const decoder = new NdjsonDecoder<{ id: number }>();

    decoder.push('{"id":1}\n\n');
    expect(decoder.finish()).toEqual({ kind: 'empty' });
  });

  test('treats a nonblank unterminated line as incomplete even when it is malformed JSON', () => {
    const decoder = new NdjsonDecoder<Record<string, unknown>>();

    decoder.push('{bad}');
    expect(decoder.finish()).toEqual({ kind: 'incomplete', raw: '{bad}' });
  });
});
