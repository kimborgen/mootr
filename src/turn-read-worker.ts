// The turn index's transcript reader (S-1580): parses the tail of a Claude Code transcript off the
// daemon's event loop, one request at a time. It returns only what turnsOf reads: messages in the
// window, without tool inputs, tool results, or reasoning, so the copy back to the daemon is small.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { Transcript } from './adapters/claude-transcript.ts';
import type { ViewMessage, ViewPart } from './agent-view.ts';

export interface TailRequest {
  id: number;
  file: string;
  since: number;
  tail: number;
}

export interface TailResult {
  id: number;
  messages?: ViewMessage[];
  // The window has older messages that weren't read or were dropped: the first turn may be cut.
  cut?: boolean;
  // Bytes read, and the transcript's size; `truncated` when the window may begin before the tail.
  read?: number;
  size?: number;
  truncated?: boolean;
  error?: string;
}

// The first row start at or after `pos`: after the next newline.
function rowStart(file: string, pos: number, size: number): number {
  if (pos <= 0) return 0;
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 16);
    for (let at = pos - 1; at < size; ) {
      const n = readSync(fd, buf, 0, buf.length, at);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) return at + nl + 1;
      at += n;
    }
    return size;
  } finally {
    closeSync(fd);
  }
}

export function readTail({ id, file, since, tail }: TailRequest): TailResult {
  const st = statSync(file);
  // A transcript last written before the window holds no turn in it.
  if (st.mtimeMs < since) return { id, messages: [], cut: false, read: 0, size: st.size, truncated: false };
  const from = rowStart(file, st.size - tail, st.size);
  const t = new Transcript(file, from);
  t.read();
  const first = t.messages.findIndex((m) => m.at >= since);
  const kept = first < 0 ? [] : t.messages.slice(first);
  const messages: ViewMessage[] = kept.map((m) => ({
    ...m,
    marks: undefined,
    parts: m.parts.flatMap((p): ViewPart[] => (p.type === 'tool' ? [{ type: 'tool', id: p.id, name: p.name, status: p.status }] : p.type === 'reasoning' ? [] : [p])),
  }));
  return {
    id,
    messages,
    cut: from > 0 || first !== 0,
    read: st.size - from,
    size: st.size,
    truncated: from > 0 && (t.messages[0]?.at ?? 0) >= since,
  };
}

parentPort?.on('message', (req: TailRequest) => {
  let out: TailResult;
  try {
    out = readTail(req);
  } catch (e) {
    out = { id: req.id, error: e instanceof Error ? e.message : String(e) };
  }
  parentPort!.postMessage(out);
});
