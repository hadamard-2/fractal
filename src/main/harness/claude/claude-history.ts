import { createReadStream, promises as fs, watch } from 'node:fs';
import type { FSWatcher, Stats } from 'node:fs';
import path from 'node:path';
import { NdjsonDecoder } from '@/main/harness/ndjson-decoder';
import type { NativeEvent } from '@/main/harness/reconciler';
import type { CaptureCompleteness, ConversationRef, ConversationSummary } from '@/shared/conversation-contract';
import type { NativeEventSink, Unsubscribe } from '@/main/harness/types';
import {
  createClaudeNormalizationContext,
  classifyClaudeRecord,
  normalizeClaudeRecord,
  unsupportedClaudeRecord,
  type ClaudeHistoryRecord,
} from '@/main/harness/claude/claude-normalizer';

const SUMMARY_SCAN_BYTES = 64 * 1024;

export interface ClaudeConversationFile {
  ref: ConversationRef;
  filePath: string;
  summary: ConversationSummary;
}

export interface ClaudeHistoryRead {
  events: AsyncIterable<NativeEvent>;
  completion: Promise<{ incompleteTail: boolean; captureCompleteness: CaptureCompleteness }>;
}

export interface ClaudeHistoryDependencies {
  readdir?: typeof fs.readdir;
  stat?: typeof fs.stat;
  open?: typeof fs.open;
  createReadStream?: typeof createReadStream;
  watch?: typeof watch;
}

export async function discoverClaudeConversations(
  rootDir: string,
  dependencies: ClaudeHistoryDependencies = {},
): Promise<ClaudeConversationFile[]> {
  const files = await walkJsonlFiles(rootDir, dependencies);
  const conversations = await Promise.all(files.map((filePath) => summarizeConversation(filePath, dependencies)));
  return conversations
    .filter((conversation): conversation is ClaudeConversationFile => conversation !== undefined)
    .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt || a.filePath.localeCompare(b.filePath));
}

export function readClaudeConversation(
  filePath: string,
  dependencies: ClaudeHistoryDependencies = {},
): ClaudeHistoryRead {
  let resolveCompletion: (value: { incompleteTail: boolean; captureCompleteness: CaptureCompleteness }) => void;
  let rejectCompletion: (reason?: unknown) => void;
  const completion = new Promise<{ incompleteTail: boolean; captureCompleteness: CaptureCompleteness }>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  async function* events(): AsyncGenerator<NativeEvent> {
    const decoder = new NdjsonDecoder<unknown>();
    const context = createClaudeNormalizationContext();
    let ordinal = 0;
    let captureCompleteness: CaptureCompleteness = 'complete';
    try {
      const stream = (dependencies.createReadStream ?? createReadStream)(filePath);
      for await (const chunk of stream) {
        for (const line of decoder.push(chunk as Uint8Array)) {
          const currentOrdinal = ordinal++;
          const lineEvents = line.ok
            ? normalizeClaudeRecord(line.value, currentOrdinal, context)
            : [unsupportedClaudeRecord(currentOrdinal)];
          for (const normalized of lineEvents) {
            captureCompleteness = lowerCompleteness(captureCompleteness, eventCompleteness(normalized));
            yield normalized;
          }
        }
      }
      const finish = decoder.finish();
      const incompleteTail = finish.kind === 'incomplete';
      if (incompleteTail) captureCompleteness = lowerCompleteness(captureCompleteness, 'partial');
      resolveCompletion?.({ incompleteTail, captureCompleteness });
    } catch (error) {
      rejectCompletion?.(error);
      throw error;
    }
  }

  return { events: events(), completion };
}

export async function watchClaudeConversation(
  filePath: string,
  sink: NativeEventSink,
  dependencies: ClaudeHistoryDependencies = {},
): Promise<Unsubscribe> {
  const stat = dependencies.stat ?? fs.stat;
  const createStream = dependencies.createReadStream ?? createReadStream;
  const watchFile = dependencies.watch ?? watch;
  const initialStat = await stat(filePath);
  let offset = 0;
  let inode = initialStat.ino;
  let decoder = new NdjsonDecoder<unknown>();
  let context = createClaudeNormalizationContext();
  let ordinal = 0;
  let closed = false;
  let work: Promise<void> = Promise.resolve();

  const consume = async (start: number, end: number, emit: boolean): Promise<void> => {
    if (end < start) return;
    const stream = createStream(filePath, { start, end });
    let cursor = start;
    for await (const chunk of stream) {
      if (closed) return;
      const bytes = Buffer.from(chunk as Uint8Array);
      const remaining = end - cursor + 1;
      const bounded = bytes.subarray(0, Math.max(0, remaining));
      for (const line of decoder.push(bounded)) {
        if (closed) return;
        const currentOrdinal = ordinal++;
        const events = line.ok
          ? normalizeClaudeRecord(line.value, currentOrdinal, context)
          : [unsupportedClaudeRecord(currentOrdinal)];
        if (emit) {
          for (const event of events) {
            if (closed) break;
            sink(event);
          }
        }
      }
      cursor += bounded.byteLength;
      offset = cursor;
      if (bounded.byteLength < bytes.byteLength || cursor > end) return;
    }
  };

  const onChange = (_eventType?: string, changedPath?: string | Buffer): void => {
    if (changedPath && path.basename(filePath) !== changedPath.toString()) return;
    work = work.then(async () => {
      if (closed) return;
      let next: Stats;
      try {
        next = await stat(filePath);
      } catch {
        return;
      }
      if (closed) return;
      const replaced = next.ino !== inode || next.size < offset;
      if (replaced) {
        offset = 0;
        inode = next.ino;
        decoder = new NdjsonDecoder<unknown>();
        context = createClaudeNormalizationContext();
        ordinal = 0;
      }
      if (next.size <= offset && !replaced) return;
      await consume(offset, next.size - 1, true);
    }).catch(() => {
      // Files can disappear during editor save/replace; the next change retries without exposing content.
    });
  };

  const watcher: FSWatcher = watchFile(path.dirname(filePath), { persistent: false }, onChange);
  work = consume(0, initialStat.size - 1, false);
  try {
    await work;
  } catch (error) {
    closed = true;
    watcher.close();
    throw error;
  }
  return () => {
    closed = true;
    watcher.close();
  };
}

async function walkJsonlFiles(rootDir: string, dependencies: ClaudeHistoryDependencies): Promise<string[]> {
  const readdir = dependencies.readdir ?? fs.readdir;
  const entries = await readdir(rootDir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) return walkJsonlFiles(entryPath, dependencies);
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [entryPath] : [];
  }));
  return nested.flat();
}

async function summarizeConversation(filePath: string, dependencies: ClaudeHistoryDependencies): Promise<ClaudeConversationFile | undefined> {
  const stat = dependencies.stat ?? fs.stat;
  const open = dependencies.open ?? fs.open;
  const fileStat = await stat(filePath);
  const handle = await open(filePath, 'r');
  try {
    const firstBytes = await readSlice(handle, 0, Math.min(SUMMARY_SCAN_BYTES, fileStat.size));
    const lastStart = Math.max(0, fileStat.size - SUMMARY_SCAN_BYTES);
    const lastBytes = lastStart === 0 ? firstBytes : await readSlice(handle, lastStart, fileStat.size - lastStart);
    const first = scanRecords(firstBytes, true, fileStat.size <= SUMMARY_SCAN_BYTES);
    const last = scanRecords(lastBytes, lastStart === 0, true);
    const firstRecord = first.records[0];
    const lastRecord = last.records.at(-1) ?? firstRecord;
    const sessionId = stringAt(first.records, 'sessionId') ?? stringAt(last.records, 'sessionId') ?? path.basename(filePath, '.jsonl');
    const projectPath = stringAt(first.records, 'cwd') ?? stringAt(last.records, 'cwd');
    if (!projectPath) return undefined;
    const createdAt = timestampAt(firstRecord) ?? fileStat.birthtimeMs;
    const updatedAt = timestampAt(lastRecord) ?? fileStat.mtimeMs;
    const title = titleFrom(first.records) ?? 'Claude conversation';
    const captureCompleteness: CaptureCompleteness = first.incomplete || last.incomplete || first.malformed || last.malformed || first.unsupported || last.unsupported
      ? 'partial'
      : fileStat.size > SUMMARY_SCAN_BYTES * 2 ? 'unknown' : 'complete';
    const ref: ConversationRef = { provider: 'claude', nativeSessionId: sessionId, projectPath };
    return {
      ref,
      filePath,
      summary: { ref, title, createdAt, updatedAt, runtime: 'unknown', captureCompleteness },
    };
  } finally {
    await handle.close();
  }
}

async function readSlice(handle: Awaited<ReturnType<typeof fs.open>>, position: number, length: number): Promise<Uint8Array> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function scanRecords(bytes: Uint8Array, startsAtBoundary: boolean, reachesEnd: boolean): { records: ClaudeHistoryRecord[]; incomplete: boolean; malformed: boolean; unsupported: boolean } {
  const text = Buffer.from(bytes).toString('utf8');
  const bounded = startsAtBoundary ? text : text.slice((text.indexOf('\n') + 1) || text.length);
  const decoder = new NdjsonDecoder<unknown>();
  const lines = decoder.push(bounded);
  const records = lines
    .filter((line): line is Extract<typeof line, { ok: true }> => line.ok)
    .map((line) => objectValue(line.value))
    .filter((record): record is ClaudeHistoryRecord => record !== undefined);
  return {
    records,
    malformed: lines.some((line) => !line.ok || (line.ok && objectValue(line.value) === undefined)),
    incomplete: reachesEnd && decoder.finish().kind === 'incomplete',
    unsupported: records.some((record) => classifyClaudeRecord(record) === 'unsupported'),
  };
}

function titleFrom(records: ClaudeHistoryRecord[]): string | undefined {
  for (const record of records) {
    const message = objectValue(record.message);
    if (record.type === 'user' && message?.role === 'user') {
      const content = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
            .map((block) => objectValue(block))
            .filter((block): block is Record<string, unknown> => block !== undefined && block.type === 'text')
            .map((block) => typeof block.text === 'string' ? block.text : '')
            .join('')
          : '';
      if (content) return content.slice(0, 120);
    }
  }
  return undefined;
}

function stringAt(records: ClaudeHistoryRecord[], key: string): string | undefined {
  return records.map((record) => record[key]).find((value): value is string => typeof value === 'string');
}

function timestampAt(record: ClaudeHistoryRecord | undefined): number | undefined {
  const timestamp = typeof record?.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function eventCompleteness(event: NativeEvent): CaptureCompleteness {
  return event.payload.kind === 'unsupported' ? event.payload.captureCompleteness : 'complete';
}

function lowerCompleteness(current: CaptureCompleteness, incoming: CaptureCompleteness): CaptureCompleteness {
  if (current === 'unknown' || incoming === 'unknown') return 'unknown';
  if (current === 'partial' || incoming === 'partial') return 'partial';
  return 'complete';
}
