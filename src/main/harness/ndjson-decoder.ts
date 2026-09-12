import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';

export type DecodedLine<T> =
  | { ok: true; value: T }
  | { ok: false; raw: string; error: 'Invalid JSON record' };

export type NdjsonFinish =
  | { kind: 'empty' }
  | { kind: 'incomplete'; raw: string };

/** Incrementally decodes UTF-8 NDJSON without exposing truncated records. */
export class NdjsonDecoder<T> {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  push(chunk: string | Uint8Array): DecodedLine<T>[] {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    this.pending += this.decoder.write(bytes);

    const decoded: DecodedLine<T>[] = [];
    let newlineIndex = this.pending.indexOf('\n');
    while (newlineIndex !== -1) {
      let line = this.pending.slice(0, newlineIndex);
      this.pending = this.pending.slice(newlineIndex + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }

      if (line.trim() !== '') {
        decoded.push(this.decodeLine(line));
      }
      newlineIndex = this.pending.indexOf('\n');
    }

    return decoded;
  }

  finish(): NdjsonFinish {
    this.pending += this.decoder.end();
    return this.pending.trim() === ''
      ? { kind: 'empty' }
      : { kind: 'incomplete', raw: this.pending };
  }

  private decodeLine(line: string): DecodedLine<T> {
    try {
      return { ok: true, value: JSON.parse(line) as T };
    } catch {
      return { ok: false, raw: line, error: 'Invalid JSON record' };
    }
  }
}
