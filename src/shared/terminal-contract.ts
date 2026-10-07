export const TERMINAL_CHANNELS = {
  invoke: 'fractal:terminal:invoke',
  event: 'fractal:terminal:event',
} as const;

export interface CreateTerminalRequest {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
}

export type TerminalRequest =
  | ({ method: 'create' } & CreateTerminalRequest)
  | { method: 'write'; id: string; data: string }
  | { method: 'resize'; id: string; cols: number; rows: number }
  | { method: 'close'; id: string };

export type TerminalEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number };

export interface TerminalApi {
  create(request: CreateTerminalRequest): Promise<{ shell: string; cwd: string }>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  close(id: string): Promise<void>;
  onEvent(listener: (event: TerminalEvent) => void): () => void;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const id = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
const data = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 1_048_576;
const absolutePath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 32_768 &&
  (value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value));
const dimensions = (cols: unknown, rows: unknown): cols is number =>
  typeof cols === 'number' && Number.isSafeInteger(cols) && cols >= 1 && cols <= 500 &&
  typeof rows === 'number' && Number.isSafeInteger(rows) && rows >= 1 && rows <= 300;
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

export function parseTerminalRequest(value: unknown): TerminalRequest {
  if (!object(value) || !id(value.id)) throw new Error('Invalid terminal request');
  if (value.method === 'create' && dimensions(value.cols, value.rows) && absolutePath(value.cwd) &&
    keys(value, ['method', 'id', 'cwd', 'cols', 'rows'])) {
    return { method: 'create', id: value.id, cwd: value.cwd, cols: value.cols, rows: value.rows as number };
  }
  if (value.method === 'write' && data(value.data) && keys(value, ['method', 'id', 'data'])) {
    return { method: 'write', id: value.id, data: value.data };
  }
  if (value.method === 'resize' && dimensions(value.cols, value.rows) && keys(value, ['method', 'id', 'cols', 'rows'])) {
    return { method: 'resize', id: value.id, cols: value.cols, rows: value.rows as number };
  }
  if (value.method === 'close' && keys(value, ['method', 'id'])) return { method: 'close', id: value.id };
  throw new Error('Invalid terminal request');
}

export function parseTerminalEvent(value: unknown): TerminalEvent {
  if (!object(value) || !id(value.id)) throw new Error('Invalid terminal event');
  if (value.type === 'data' && data(value.data)) return { type: 'data', id: value.id, data: value.data };
  if (value.type === 'exit' && typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode)) {
    return { type: 'exit', id: value.id, exitCode: value.exitCode };
  }
  throw new Error('Invalid terminal event');
}
