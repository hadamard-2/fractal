/**
 * A file's bytes as UTF-8 text, or undefined when they are binary: any NUL
 * byte, or bytes that are not valid UTF-8. With `truncated`, a multibyte
 * character cut off at the end is held back instead of failing the decode.
 */
export function decodeText(bytes: Uint8Array, truncated = false): string | undefined {
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated }); } catch { return undefined; }
}
