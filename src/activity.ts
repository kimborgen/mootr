// Activity items (S-210): each agent's transcript read into a per-item timeline in
// activity_items, with what its clock waited on and an estimated cost per item. Classifying
// items into activity categories is a later step (S-204); category columns stay null here.
//
//   tool    a tool call, from its use to its result
//   text    an assistant text block (an instant; its writing is in the model item around it)
//   model   from a result or prompt to the next assistant message, merged while the model
//           keeps writing, until a tool call or the turn's end
//   gap     from a turn's end to the next prompt; name is the trigger that ended it
//
// A reader turns one harness's transcript into items, harness-neutral from there on: wait
// kinds for gaps come from stam's own notice text (the same templates reach every harness)
// and from the agent's events; cost splits each message's price over the items it produced
// (raw_cost_usd), then each agent's days are scaled to its usage rows (est_cost_usd). Readers
// stop at definite turn boundaries, so a cursor never sits inside a turn or a message, and
// they hand items over in slices so a large backfill never holds the daemon's event loop.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from './db.ts';
import * as tree from './tree.ts';
import { priceUsd } from './attribution.ts';
import { classifyByRules, classifyItems, type RuleItem } from './activity-rules.ts';
import { touched } from './activity-changes.ts';

export type ItemKind = 'tool' | 'text' | 'model' | 'gap';

// What a reader emits. Times are ms since the epoch. `msg` groups the items one model
// message produced, for cost; `trigger` is set on gaps.
export interface RawItem {
  kind: ItemKind;
  turn: number;
  name: string | null;
  start: number;
  end: number;
  summary: string | null;
  msg?: string;
  // Tools: the input, for the wait rules (never stored whole).
  input?: Record<string, unknown>;
  trigger?: Trigger;
}

// What ended a gap, as the reader saw it.
export interface Trigger {
  // prompt: typed by the human; notice: a stam notice (or other meta prompt); job: a
  // background task's completion notice; timer: the harness's own scheduled wake-up;
  // none: the model continued with no prompt at all.
  source: 'prompt' | 'notice' | 'job' | 'timer' | 'none';
  text: string;
}

export interface MessageUsage {
  model: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  // The message's price as its harness recorded it, when it did; else priced from its tokens.
  cost_usd?: number;
}

export interface Cursor {
  source: string;
  offset: number;
  state: Record<string, unknown>;
}

// One slice of a read: items of whole turns, the usage of the messages they came from, and
// the cursor after them.
export interface ReadResult {
  items: RawItem[];
  usage: Map<string, MessageUsage>;
  cursor: Cursor;
}

export interface ReadOptions {
  // Whether stam saw the agent's turn end (a Stop, StopFailure, or SessionEnd hook, or a
  // resume or restart) at or after `from` and, when given, at or before `to` (ms). The
  // authority for a turn end the transcript doesn't show: at the end of the file, and for a
  // prompt that arrives while a turn looks unfinished. Asked when needed, never up front.
  turnEnded(from: number, to?: number): boolean;
}

// One harness's transcript reader. `read` continues from `cursor` (null: from the start)
// and yields slices, each ending at a turn boundary; it yields to the event loop between
// slices and within long stretches. Null when the agent has no transcript to read. When the
// source changed or shrank, a reader starts it over and skips what the cursor's state
// already covers, so nothing is counted twice.
export interface TranscriptReader {
  harness: string;
  read(agent: db.Agent, cursor: Cursor | null, opts: ReadOptions): AsyncGenerator<ReadResult> | null;
}

const readers = new Map<string, TranscriptReader>();

export function registerReader(r: TranscriptReader): void {
  readers.set(r.harness, r);
}

const SUMMARY_MAX = 300;
const SHORT_MS = 5_000;
const STALL_MS = 5 * 60_000;
// A slice ends at the first turn boundary after this many lines or this much time.
const SLICE_LINES = 2_000;
const SLICE_MS = 20;

const clip = (s: string | null | undefined) => (s == null ? null : s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) : s);
const iso = (t: number) => new Date(t).toISOString();
const tick = () => new Promise<void>((r) => setImmediate(r));

// ---- Claude Code ------------------------------------------------------------------------

// Complete lines of a file from a byte offset, with the offset after each, read in chunks.
function* linesFrom(path: string, offset: number): Generator<{ line: string; start: number; end: number }> {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(4 << 20);
    let pos = offset;
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) return;
      pos += n;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      const base = pos - chunk.length;
      let from = 0;
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, from)) {
        yield { line: chunk.toString('utf8', from, i), start: base + from, end: base + i + 1 };
        from = i + 1;
      }
      carry = chunk.subarray(from);
    }
  } finally {
    closeSync(fd);
  }
}

function toolSummary(input: Record<string, unknown>): string {
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
  return typeof pick === 'string' ? pick : JSON.stringify(input);
}

function promptText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('\n');
  return '';
}

interface ClaudeState {
  lastT: number | null;
  // The newest row read and the uuids of the rows at that time, so a source read over again
  // skips exactly the rows already read.
  seenT: number | null;
  seenIds: string[];
  turn: number;
  // The message that ended the last turn (INTERRUPTED for an interrupted one); null while a
  // turn runs. More rows of that message continue it rather than start a gap.
  endMsg: string | null;
}

const INTERRUPTED = '<interrupted>';
const STOPPED = '<stopped>';

// Claude Code's JSONL: one row per content block, each assistant row carrying its message's
// id, stop_reason, and (repeated) usage. A turn ends at a message with stop_reason end_turn,
// or at Claude Code's "[Request interrupted" row. Prompts are user rows with string content
// that aren't meta, plus meta rows that are stam channel notices or task notifications:
// counting those as prompts keeps hours of waiting from reading as model time. A prompt
// during a running turn (a notice before the model answered) is part of that turn, unless
// stam saw the turn end in between (opts.turnEnded), as when it died without an end_turn.
export async function* readClaude(path: string, cursor: Cursor | null, opts: ReadOptions): AsyncGenerator<ReadResult> {
  const st: ClaudeState = { lastT: null, seenT: null, seenIds: [], turn: 0, endMsg: null, ...((cursor?.state ?? {}) as Partial<ClaudeState>) };
  const restart = !!cursor && (cursor.source !== path || cursor.offset > statSync(path).size);
  const offset = cursor && !restart ? cursor.offset : 0;
  // Starting a source over: rows older than the newest one read, or as old and already read,
  // are skipped.
  let skipping = restart && st.seenT != null;
  const seen = new Set(st.seenIds);
  // The row just read, recorded as seen once the next row starts (a boundary marked at the
  // next row's start must not count the next row).
  let lastRow: { T: number; id: string | null } | null = null;
  const see = () => {
    if (!lastRow) return;
    if (lastRow.T !== st.seenT) st.seenIds = [];
    st.seenT = lastRow.T;
    if (lastRow.id) st.seenIds = [...st.seenIds, lastRow.id];
    lastRow = null;
  };
  // Rows of the message that ended the last committed turn are never read twice.
  const doneMsg = st.endMsg;
  const usage = new Map<string, MessageUsage>();
  const pending = new Map<string, RawItem>();
  let items: RawItem[] = [];
  let model: RawItem | null = null;
  let afterEnd = st.endMsg != null;
  let safe = { offset, items: 0, state: { ...st, seenIds: [...st.seenIds] } };
  let emitted = offset;
  let lines = 0;
  let since = Date.now();

  const closeModel = () => {
    if (!model) return;
    items.push(model);
    model = null;
  };
  const closePending = (t: number) => {
    for (const p of pending.values()) items.push({ ...p, end: Math.max(p.start, t) });
    pending.clear();
  };
  // A boundary: the last turn's model item closes here, not at its end_turn row, since more
  // rows of that message may follow.
  const markSafe = (at: number) => {
    closeModel();
    safe = { offset: at, items: items.length, state: { ...st, seenIds: [...st.seenIds] } };
  };
  const endTurn = (msg: string, t: number) => {
    closePending(t);
    st.endMsg = msg;
    afterEnd = true;
  };
  // Hands over what lies before the last boundary.
  const slice = (): ReadResult => {
    const out = items.slice(0, safe.items);
    items = items.slice(safe.items);
    safe.items = 0;
    emitted = safe.offset;
    return { items: out, usage, cursor: { source: path, offset: safe.offset, state: safe.state } };
  };

  let lastEnd = offset;
  for (const { line, start: lineStart, end: lineEnd } of linesFrom(path, offset)) {
    lastEnd = lineEnd;
    if (++lines >= SLICE_LINES || Date.now() - since >= SLICE_MS) {
      if (safe.offset !== emitted) yield slice();
      await tick();
      lines = 0;
      since = Date.now();
    }
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if ((d.type !== 'user' && d.type !== 'assistant') || !d.timestamp) continue;
    const T = Date.parse(d.timestamp);
    if (Number.isNaN(T)) continue;
    const rowId: string | null = typeof d.uuid === 'string' ? d.uuid : null;
    if (skipping) {
      if (T < st.seenT! || (T === st.seenT && (!rowId || seen.has(rowId)))) continue;
      skipping = false;
    }
    see();
    lastRow = { T, id: rowId };
    const m = d.message ?? {};
    if (d.type === 'assistant') {
      const msgId: string = m.id ?? d.uuid;
      if (msgId === doneMsg) continue;
      if (afterEnd && msgId !== st.endMsg) markSafe(lineStart);
      const u = m.usage;
      if (u) {
        usage.set(msgId, {
          model: String(m.model ?? ''),
          tokens_in: u.input_tokens ?? 0,
          tokens_out: u.output_tokens ?? 0,
          tokens_cache_read: u.cache_read_input_tokens ?? 0,
          tokens_cache_write: u.cache_creation_input_tokens ?? 0,
        });
      }
      if (st.lastT != null && pending.size === 0) {
        if (afterEnd && msgId !== st.endMsg) {
          items.push({ kind: 'gap', turn: st.turn, name: 'none', start: st.lastT, end: T, summary: null, trigger: { source: 'none', text: '' } });
        } else {
          model ??= { kind: 'model', turn: st.turn, name: null, start: st.lastT, end: T, summary: null };
          model.end = T;
          model.msg = msgId;
        }
      }
      if (msgId !== st.endMsg) {
        afterEnd = false;
        st.endMsg = null;
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === 'tool_use') {
          closeModel();
          const input = (b.input ?? {}) as Record<string, unknown>;
          const name = String(b.name ?? '?');
          pending.set(String(b.id), { kind: 'tool', turn: st.turn, name, start: T, end: T, summary: clip(toolSummary(input)), msg: msgId, input });
        } else if (b?.type === 'text' && String(b.text ?? '').trim()) {
          items.push({ kind: 'text', turn: st.turn, name: null, start: T, end: T, summary: clip(String(b.text)), msg: msgId });
        }
      }
      st.lastT = T;
      if (m.stop_reason === 'end_turn') endTurn(msgId, T);
      continue;
    }
    const c = m.content;
    const results = Array.isArray(c) ? c.filter((b: any) => b?.type === 'tool_result') : [];
    if (results.length) {
      for (const b of results) {
        const p = pending.get(String(b.tool_use_id));
        if (!p) continue;
        pending.delete(String(b.tool_use_id));
        items.push({ ...p, end: T });
      }
      st.lastT = T;
      continue;
    }
    const text = promptText(c);
    if (text.startsWith('[Request interrupted')) {
      if (!afterEnd) {
        if (st.lastT != null) closePending(st.lastT);
        closeModel();
        st.lastT = T;
        endTurn(INTERRUPTED, T);
      }
      continue;
    }
    const job = text.includes('<task-notification>');
    const notice = text.startsWith('<channel') || text.includes('[stam]');
    if (d.isMeta && !job && !notice) continue;
    if (!text.trim() && !job) continue;
    if (!afterEnd && st.lastT != null && opts.turnEnded(st.lastT, T)) {
      // The turn ended without saying so in the transcript.
      closePending(st.lastT);
      closeModel();
      endTurn(STOPPED, st.lastT);
    }
    if (!afterEnd && st.lastT != null) {
      // Context for the running turn: the model is still on it.
      if (pending.size === 0) {
        model ??= { kind: 'model', turn: st.turn, name: null, start: st.lastT!, end: T, summary: null };
        model.end = T;
      }
      st.lastT = T;
      continue;
    }
    if (afterEnd) markSafe(lineStart);
    closeModel();
    if (st.lastT != null) {
      closePending(st.lastT);
      const timer = /ScheduleWakeup|<wakeup|<<autonomous-loop/.test(text);
      const source: Trigger['source'] = job ? 'job' : timer ? 'timer' : notice || d.isMeta ? 'notice' : 'prompt';
      items.push({ kind: 'gap', turn: st.turn, name: null, start: st.lastT, end: T, summary: clip(text.replace(/<\/?channel[^>]*>/g, '').trim()), trigger: { source, text: text.slice(0, 2000) } });
    }
    st.turn++;
    st.lastT = T;
    st.endMsg = null;
    afterEnd = false;
  }
  see();
  // The end of the file is a boundary only once stam saw this turn end (asked now, after any
  // yields, so a turn that started meanwhile isn't cut).
  if (st.lastT != null && opts.turnEnded(st.lastT)) {
    if (!afterEnd) {
      closePending(st.lastT);
      endTurn(STOPPED, st.lastT);
    }
    markSafe(lastEnd);
  }
  if (safe.offset !== emitted) yield slice();
}

registerReader({
  harness: 'claude',
  read(agent, cursor, opts) {
    if (!agent.transcript_path) return null;
    try {
      statSync(agent.transcript_path);
    } catch {
      return null;
    }
    return readClaude(agent.transcript_path, cursor, opts);
  },
});

// ---- Shared pieces of the other readers ---------------------------------------------------

// What ended a gap, from a prompt-like text: stam's notices and task completions are not the human.
function triggerOf(text: string, meta: boolean): Trigger {
  const job = text.includes('<task-notification>');
  const notice = text.startsWith('<channel') || text.includes('[stam]');
  const timer = /ScheduleWakeup|<wakeup|<<autonomous-loop/.test(text);
  const source: Trigger['source'] = job ? 'job' : timer ? 'timer' : notice || meta ? 'notice' : 'prompt';
  return { source, text: text.slice(0, 2000) };
}

const gapSummary = (text: string) => clip(text.replace(/<\/?channel[^>]*>/g, '').trim());

// The items one model response produced. They wait in the bucket until the response's usage
// row names it; an item made later for the same response (a tool's result) takes the name then.
interface Bucket {
  msg: string | null;
  items: RawItem[];
}

function emitTo(b: Bucket, out: RawItem[], it: RawItem): void {
  out.push(it);
  if (b.msg) it.msg = b.msg;
  else b.items.push(it);
}

function nameBucket(b: Bucket, msg: string): void {
  b.msg = msg;
  for (const it of b.items) it.msg = msg;
  b.items = [];
}

// ---- OpenCode -----------------------------------------------------------------------------

// OpenCode's store, read-only: stam's server runs with the default data home, so this is the
// store its sessions are in. Its session_message rows hold each message, with its parts in data.
export function openCodeStore(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'opencode', 'opencode.db');
}

interface OpenCodeState {
  lastT: number | null;
  turn: number;
  running: boolean;
}

const OPENCODE_PAGE = 200;

// OpenCode's session_message rows, in seq order. A user or synthetic row is a prompt (synthetic
// is a background task's completion); an assistant row is one model message, whose parts are
// its text and tool calls. A message finished with anything but tool-calls ends the turn.
// The cursor's offset is the seq of the last row of a finished turn.
export async function* readOpenCode(dbPath: string, sessionId: string, cursor: Cursor | null, opts: ReadOptions): AsyncGenerator<ReadResult> {
  const source = `${dbPath}#${sessionId}`;
  const same = !!cursor && cursor.source === source;
  const st: OpenCodeState = { lastT: null, turn: 0, running: false, ...((same ? cursor!.state : {}) as Partial<OpenCodeState>) };
  let seq = same ? cursor!.offset : 0;
  let prevSeq = seq;
  const d = new DatabaseSync(dbPath, { readOnly: true });
  const usage = new Map<string, MessageUsage>();
  let items: RawItem[] = [];
  let safe = { seq, items: 0, state: { ...st } };
  let emitted = seq;
  let lines = 0;
  let since = Date.now();
  // A turn's end: the boundary is the row that ends it, or the row before one stam saw end it.
  const endTurn = (at: number, t: number) => {
    st.running = false;
    st.lastT = t;
    safe = { seq: at, items: items.length, state: { ...st } };
  };
  const slice = (): ReadResult => {
    const out = items.slice(0, safe.items);
    items = items.slice(safe.items);
    safe.items = 0;
    emitted = safe.seq;
    return { items: out, usage, cursor: { source, offset: safe.seq, state: safe.state } };
  };
  try {
    for (;;) {
      const rows = d
        .prepare('SELECT id, seq, type, time_created, data FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .all(sessionId, seq, OPENCODE_PAGE) as { id: string; seq: number; type: string; time_created: number; data: string }[];
      if (!rows.length) break;
      for (const row of rows) {
        const before = prevSeq;
        prevSeq = row.seq;
        seq = row.seq;
        if (++lines >= SLICE_LINES || Date.now() - since >= SLICE_MS) {
          if (safe.seq !== emitted) yield slice();
          await tick();
          lines = 0;
          since = Date.now();
        }
        let j: any;
        try {
          j = JSON.parse(row.data);
        } catch {
          continue;
        }
        if (row.type === 'user' || row.type === 'synthetic') {
          const text = String(j.text ?? '');
          const T = Number(j.time?.created ?? row.time_created);
          if (st.running && st.lastT != null && opts.turnEnded(st.lastT, T)) endTurn(before, st.lastT);
          // Context for the running turn: the model is still on it.
          if (st.running || !text.trim()) continue;
          if (st.lastT != null) {
            const trigger = row.type === 'synthetic' ? { source: 'job' as const, text: text.slice(0, 2000) } : triggerOf(text, false);
            items.push({ kind: 'gap', turn: st.turn, name: null, start: st.lastT, end: T, summary: gapSummary(text), trigger });
          }
          st.turn++;
          st.running = true;
          st.lastT = T;
        } else if (row.type === 'assistant') {
          if (!st.running) {
            if (st.lastT != null) items.push({ kind: 'gap', turn: st.turn, name: 'none', start: st.lastT, end: Number(j.time?.created ?? row.time_created), summary: null, trigger: { source: 'none', text: '' } });
            st.turn++;
            st.running = true;
          }
          const t = j.tokens ?? {};
          usage.set(row.id, {
            model: String(j.model?.id ?? ''),
            tokens_in: t.input ?? 0,
            tokens_out: t.output ?? 0,
            tokens_cache_read: t.cache?.read ?? 0,
            tokens_cache_write: t.cache?.write ?? 0,
            cost_usd: typeof j.cost === 'number' ? j.cost : undefined,
          });
          const streamed = Number(j.time?.streamed ?? j.time?.created ?? row.time_created);
          // The message ends when it completes, after its tools, which can end later still.
          let end = Math.max(streamed, Number(j.time?.completed ?? streamed));
          if (st.lastT != null) items.push({ kind: 'model', turn: st.turn, name: null, start: st.lastT, end: Math.max(st.lastT, streamed), summary: null, msg: row.id });
          for (const part of Array.isArray(j.content) ? j.content : []) {
            if (part?.type === 'text' && String(part.text ?? '').trim()) {
              items.push({ kind: 'text', turn: st.turn, name: null, start: streamed, end: streamed, summary: clip(String(part.text)), msg: row.id });
            } else if (part?.type === 'tool') {
              const ran = Number(part.time?.ran ?? streamed);
              const done = Math.max(ran, Number(part.time?.completed ?? ran));
              end = Math.max(end, done);
              const inner: any[] = Array.isArray(part.state?.metadata?.toolCalls) ? part.state.metadata.toolCalls : [];
              if (part.name === 'execute' && inner.length) {
                // Code mode: one item per inner call, its own times when it has them, else the span split evenly.
                const n = inner.length;
                inner.forEach((c, i) => {
                  const own = Number.isFinite(Number(c?.time?.ran)) && Number.isFinite(Number(c?.time?.completed));
                  const s = own ? Number(c.time.ran) : ran + ((done - ran) * i) / n;
                  const e = own ? Number(c.time.completed) : ran + ((done - ran) * (i + 1)) / n;
                  // The store records no per-call input: the inner calls share the part's code.
                  const input = (c?.input ?? c?.state?.input ?? part.state?.input ?? {}) as Record<string, unknown>;
                  items.push({ kind: 'tool', turn: st.turn, name: String(c?.tool ?? 'execute'), start: s, end: e, summary: clip(toolSummary(input)), msg: row.id, input });
                });
              } else {
                const input = (part.state?.input ?? {}) as Record<string, unknown>;
                items.push({ kind: 'tool', turn: st.turn, name: String(part.name ?? '?'), start: ran, end: done, summary: clip(toolSummary(input)), msg: row.id, input });
              }
            }
          }
          st.lastT = end;
          if (j.finish && j.finish !== 'tool-calls') endTurn(row.seq, end);
        }
      }
    }
    // The end of the rows: the turn ended only if stam saw it end.
    if (st.running && st.lastT != null && opts.turnEnded(st.lastT)) endTurn(prevSeq, st.lastT);
  } finally {
    d.close();
  }
  if (safe.seq !== emitted) yield slice();
}

registerReader({
  harness: 'opencode',
  read(agent, cursor, opts) {
    if (!agent.session_id) return null;
    const path = openCodeStore();
    try {
      statSync(path);
    } catch {
      return null;
    }
    return readOpenCode(path, agent.session_id, cursor, opts);
  },
});

// ---- Codex --------------------------------------------------------------------------------

interface CodexState {
  lastT: number | null;
  // The time of the row that ended the last turn. A source read over again skips the rows at or
  // before it, which the cursor's state already covers.
  seenT: number | null;
  // The ordinal of that row, which tells rows at the same time apart.
  seenOrd: number | null;
  turn: number;
  running: boolean;
  model: string | null;
}

// A tool call not yet answered: its start, its name and input, the inner calls of a code-mode
// exec, and the response's bucket.
interface CodexCall {
  start: number;
  turn: number;
  name: string;
  input: Record<string, unknown>;
  inner: { name: string; input: Record<string, unknown> }[];
  bucket: Bucket;
}

function codexCall(p: any, start: number, turn: number, bucket: Bucket): CodexCall {
  const name = String(p.name ?? '?');
  const raw = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : '';
  if (name === 'exec') {
    // Code mode: the tools it calls by name (tools.exec_command({cmd: ...})), in order.
    const names = [...raw.matchAll(/tools\.([A-Za-z_]\w*)\(/g)].map((m) => m[1]);
    const cmds = [...raw.matchAll(/cmd\s*:\s*("(?:[^"\\]|\\.)*")/g)].map((m) => {
      try {
        return JSON.parse(m[1]) as string;
      } catch {
        return m[1];
      }
    });
    let k = 0;
    const inner = names.map((n) => ({ name: n, input: n === 'exec_command' && k < cmds.length ? { command: cmds[k++] } : {} }));
    return { start, turn, name, input: {}, inner, bucket };
  }
  let args: Record<string, unknown> = {};
  try {
    const a = raw ? JSON.parse(raw) : {};
    args = a && typeof a === 'object' ? a : { input: raw };
  } catch {
    args = { input: raw };
  }
  const cmd = args.cmd ?? args.command;
  const input = cmd != null ? { ...args, command: Array.isArray(cmd) ? cmd.join(' ') : String(cmd) } : args;
  return { start, turn, name, input, inner: [], bucket };
}

// A call's tool items, from its start to its result: one per inner call of a code-mode exec
// (the span split evenly, as the calls' own times aren't in the rollout), else one for the call.
function codexTools(c: CodexCall, end: number): RawItem[] {
  if (!c.inner.length) return [{ kind: 'tool', turn: c.turn, name: c.name, start: c.start, end, summary: clip(toolSummary(c.input)), input: c.input }];
  const n = c.inner.length;
  const span = Math.max(0, end - c.start);
  return c.inner.map((x, i) => ({
    kind: 'tool',
    turn: c.turn,
    name: x.name,
    start: c.start + Math.round((span * i) / n),
    end: c.start + Math.round((span * (i + 1)) / n),
    summary: clip(toolSummary(x.input)),
    input: x.input,
  }));
}

const codexText = (content: unknown): string => (Array.isArray(content) ? content : []).map((b: any) => String(b?.text ?? '')).join('\n');

// Codex's rollout JSONL (~/.codex/sessions): a user message starts a turn, its agent messages
// are text, each tool call is a function or custom call answered by an output row, and a
// task_complete ends the turn. A token_usage_record names the response its items came from.
// Reasoning is encrypted, so it is skipped.
export async function* readCodex(path: string, cursor: Cursor | null, opts: ReadOptions): AsyncGenerator<ReadResult> {
  const restart = !!cursor && (cursor.source !== path || cursor.offset > statSync(path).size);
  const st: CodexState = { lastT: null, seenT: null, seenOrd: null, turn: 0, running: false, model: null, ...((cursor?.state ?? {}) as Partial<CodexState>) };
  const offset = cursor && !restart ? cursor.offset : 0;
  // Starting over: rows at or before the cursor's state are skipped, so nothing counts twice.
  let skipping = restart && st.seenT != null;
  const usage = new Map<string, MessageUsage>();
  const pending = new Map<string, CodexCall>();
  let bucket: Bucket = { msg: null, items: [] };
  // The bucket of the response whose usage row came last: a turn's final model time is its.
  let closed: Bucket | null = null;
  let items: RawItem[] = [];
  let safe = { offset, items: 0, state: { ...st } };
  let emitted = offset;
  let lastEnd = offset;
  // The time of the last row read: where a turn that stam saw end, with no end row, stops.
  let lastRowT: number | null = null;
  let lastRowOrd: number | null = null;
  let lines = 0;
  let since = Date.now();
  const modelUntil = (t: number) => {
    if (!st.running || st.lastT == null) return;
    emitTo(bucket, items, { kind: 'model', turn: st.turn, name: null, start: st.lastT, end: Math.max(st.lastT, t), summary: null });
    st.lastT = null;
  };
  const closePending = (t: number) => {
    for (const c of pending.values()) for (const it of codexTools(c, Math.max(c.start, t))) emitTo(c.bucket, items, it);
    pending.clear();
  };
  const endTurn = (at: number, t: number, ord: number | null) => {
    modelUntil(t);
    closePending(t);
    st.running = false;
    st.lastT = t;
    st.seenT = t;
    st.seenOrd = ord;
    safe = { offset: at, items: items.length, state: { ...st } };
  };
  const slice = (): ReadResult => {
    const out = items.slice(0, safe.items);
    items = items.slice(safe.items);
    safe.items = 0;
    emitted = safe.offset;
    return { items: out, usage, cursor: { source: path, offset: safe.offset, state: safe.state } };
  };

  for (const { line, start: lineStart, end: lineEnd } of linesFrom(path, offset)) {
    lastEnd = lineEnd;
    if (++lines >= SLICE_LINES || Date.now() - since >= SLICE_MS) {
      if (safe.offset !== emitted) yield slice();
      await tick();
      lines = 0;
      since = Date.now();
    }
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const T = Date.parse(d.timestamp);
    if (Number.isNaN(T)) continue;
    const ord = typeof d.ordinal === 'number' ? d.ordinal : null;
    const prevT = lastRowT;
    const prevOrd = lastRowOrd;
    lastRowT = T;
    lastRowOrd = ord;
    if (skipping) {
      // Rows before the boundary, and those at its time that come before it in the file.
      const covered = st.seenT != null && (T < st.seenT || (T === st.seenT && (ord == null || st.seenOrd == null || ord <= st.seenOrd)));
      if (covered) continue;
      skipping = false;
    }
    const p = d.payload && typeof d.payload === 'object' ? d.payload : {};
    if (d.type === 'turn_context') {
      if (p.model) st.model = String(p.model);
    } else if (d.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'UserMessage') {
      const text = codexText(p.item.content);
      if (st.running && st.lastT != null && opts.turnEnded(st.lastT, T)) endTurn(lineStart, prevT ?? st.lastT, prevOrd);
      // Context for the running turn: the model is still on it.
      if (st.running || !text.trim()) continue;
      if (st.lastT != null) items.push({ kind: 'gap', turn: st.turn, name: null, start: st.lastT, end: T, summary: gapSummary(text), trigger: triggerOf(text, false) });
      st.turn++;
      st.running = true;
      st.lastT = T;
    } else if (d.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'AgentMessage') {
      if (!st.running) continue;
      for (const c of Array.isArray(p.item.content) ? p.item.content : []) {
        const t = String(c?.text ?? '');
        if (t.trim()) emitTo(bucket, items, { kind: 'text', turn: st.turn, name: null, start: T, end: T, summary: clip(t) });
      }
    } else if (d.type === 'event_msg' && p.type === 'task_complete') {
      if (st.running) {
        if (!bucket.items.length && closed) bucket = closed;
        endTurn(lineEnd, T, ord);
      }
      bucket = { msg: null, items: [] };
      closed = null;
    } else if (d.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call')) {
      if (!st.running) continue;
      modelUntil(T);
      pending.set(String(p.call_id), codexCall(p, T, st.turn, bucket));
    } else if (d.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output')) {
      const c = pending.get(String(p.call_id));
      if (!c) continue;
      pending.delete(String(p.call_id));
      for (const it of codexTools(c, T)) emitTo(c.bucket, items, it);
      // A tool's result starts model time only once no other tool is still running.
      if (st.running && pending.size === 0) st.lastT = T;
    } else if (d.type === 'token_usage_record' || (d.type === 'event_msg' && p.type === 'token_usage_record')) {
      const id = String(p.response_id ?? '');
      if (!id) continue;
      const u = p.usage ?? {};
      const cached = u.cached_input_tokens ?? 0;
      usage.set(id, {
        model: st.model ?? '',
        tokens_in: Math.max(0, (u.input_tokens ?? 0) - cached),
        tokens_out: u.output_tokens ?? 0,
        tokens_cache_read: cached,
        tokens_cache_write: u.cache_write_input_tokens ?? 0,
      });
      nameBucket(bucket, id);
      closed = bucket;
      bucket = { msg: null, items: [] };
    }
  }
  // The end of the file: the turn ended only if stam saw it end.
  if (st.running && st.lastT != null && opts.turnEnded(st.lastT)) endTurn(lastEnd, lastRowT ?? st.lastT, lastRowOrd);
  if (safe.offset !== emitted) yield slice();
}

registerReader({
  harness: 'codex',
  read(agent, cursor, opts) {
    if (!agent.transcript_path) return null;
    try {
      statSync(agent.transcript_path);
    } catch {
      return null;
    }
    return readCodex(agent.transcript_path, cursor, opts);
  },
});

// ---- Wait kinds -------------------------------------------------------------------------

// A tool call's wait kind, from its command and duration. A long call to a local file tool
// waited on a permission prompt; a long shell command nothing else explains ran a program,
// which counts with builds.
export function toolWait(name: string, input: Record<string, unknown> | undefined, ms: number): string {
  if (name === 'Agent' || name === 'Task') return 'agent.child';
  if (name === 'AskUserQuestion') return 'human.reply';
  if (ms < SHORT_MS) return 'tool.short';
  if (name === 'Monitor' || name === 'ScheduleWakeup') return 'tool.sleep';
  if (name === 'WebFetch' || name === 'WebSearch' || name.startsWith('mcp__')) return 'tool.network';
  const cmd = typeof input?.command === 'string' ? input.command : '';
  if (!cmd) return ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'NotebookEdit', 'ExitPlanMode'].includes(name) ? 'human.permission' : 'tool.network';
  if (/chromium[-_.]?lock|\bflock\b|\buptime\b|load ?average|\/proc\/loadavg|waiting for (the )?lock/i.test(cmd)) return 'tool.contention';
  if (/(^|[\s;&|(])sleep\s+\d|\b(until|while)\b[^\n]*;\s*do/.test(cmd)) return 'tool.sleep';
  if (/(^|[\s/])test\/|\bvitest\b|node --test|\.test\.|\be2e\b|phone\.mjs|shots\.mjs|web\/check\/run\.sh|\bnpm (run )?test\b|\bpytest\b|\bcargo test\b|\bgo test\b/.test(cmd)) return 'tool.test';
  if (/\b(curl|wget|gh|ssh|scp|rsync)\b|(^|[\s/])box\s|\bgit (push|fetch|pull|clone|ls-remote)\b/.test(cmd)) return 'tool.network';
  return 'tool.build';
}

export function modelWait(ms: number): string {
  return ms > STALL_MS ? 'model.stall' : 'model.generate';
}

// Context for gap rules: the agent's children by name, other agents' kinds by name, and the
// intervals it was paused or cost-blocked, from events.
export interface GapContext {
  children: Set<string>;
  release: Set<string>;
  throttles: { from: number; to: number; kind: 'throttle.cost' | 'throttle.scheduler' }[];
  timers: number[];
}

export function gapContext(agent: db.Agent): GapContext {
  const d = db.open();
  const names = (ids: string[]) => ids.map((id) => db.getAgent(id)?.name).filter((n): n is string => Boolean(n));
  const children = new Set(names(tree.childrenOf(agent.id)));
  const release = new Set(
    (d.prepare("SELECT name FROM agents WHERE type IN ('release', 'reviewer') OR name LIKE 'release%' OR name LIKE 'review%'").all() as { name: string }[]).map((r) => r.name),
  );
  const rows = d
    .prepare("SELECT ts, type, data FROM events WHERE agent_id = ? AND type IN ('pause', 'unpause', 'blocker:add', 'blocker:clear', 'cost:override', 'cost:pause', 'wait:woke') ORDER BY id")
    .all(agent.id) as { ts: string; type: string; data: string | null }[];
  const throttles: GapContext['throttles'] = [];
  const timers: number[] = [];
  // A cost throttle lasts while any cost hold is on: each blocker by kind and account, and a
  // cost pause. A scheduler throttle runs from a pause to the unpause, which stam sends only
  // once nothing holds the agent.
  const holds = new Set<string>();
  let costFrom: number | null = null;
  let pausedFrom: number | null = null;
  const hold = (key: string, on: boolean, t: number) => {
    if (on) holds.add(key);
    else holds.delete(key);
    if (holds.size && costFrom == null) costFrom = t;
    if (!holds.size && costFrom != null) {
      throttles.push({ from: costFrom, to: t, kind: 'throttle.cost' });
      costFrom = null;
    }
  };
  for (const r of rows) {
    const t = Date.parse(r.ts);
    let data: any = {};
    try {
      data = r.data ? JSON.parse(r.data) : {};
    } catch {}
    if (r.type === 'pause') pausedFrom ??= t;
    else if (r.type === 'unpause' && pausedFrom != null) {
      throttles.push({ from: pausedFrom, to: t, kind: 'throttle.scheduler' });
      pausedFrom = null;
    } else if (r.type === 'blocker:add' || r.type === 'blocker:clear') hold(`blocker:${data.kind ?? ''}:${data.account ?? ''}`, r.type === 'blocker:add', t);
    else if (r.type === 'cost:override') for (const k of [...holds].filter((h) => h.startsWith('blocker:'))) hold(k, false, t);
    else if (r.type === 'cost:pause') hold('cost:pause', data.action !== 'clear', t);
    else if (r.type === 'wait:woke') timers.push(t);
  }
  if (costFrom != null) throttles.push({ from: costFrom, to: Infinity, kind: 'throttle.cost' });
  if (pausedFrom != null) throttles.push({ from: pausedFrom, to: Infinity, kind: 'throttle.scheduler' });
  return { children, release, throttles, timers };
}

const TIMER_SLACK_MS = 2 * 60_000;

// A gap's wait kind and name, from what ended it. A gap mostly (over half) spent paused or
// cost-blocked is throttle.*, whatever ended it; cost wins over a scheduler pause.
export function gapWait(item: RawItem, ctx: GapContext): { wait: string; name: string } {
  const dur = Math.max(1, item.end - item.start);
  const over: Record<string, number> = {};
  for (const th of ctx.throttles) {
    const o = Math.min(item.end, th.to) - Math.max(item.start, th.from);
    if (o > 0) over[th.kind] = (over[th.kind] ?? 0) + o;
  }
  if ((over['throttle.cost'] ?? 0) * 2 > dur) return { wait: 'throttle.cost', name: 'throttle' };
  if ((over['throttle.cost'] ?? 0) + (over['throttle.scheduler'] ?? 0) > dur / 2) return { wait: 'throttle.scheduler', name: 'throttle' };
  const tr = item.trigger ?? { source: 'none', text: '' };
  if (tr.source === 'job') return { wait: 'job.background', name: 'job' };
  if (tr.source === 'timer') return { wait: 'event.timer', name: 'timer' };
  if (tr.source === 'none') return { wait: 'idle.none', name: 'none' };
  const s = tr.text;
  const child = /Your child agent (\S+) finished its turn/.exec(s) ?? /Agent (\S+), your child/.exec(s);
  if (child || /a child of your S-\d+/.test(s)) return { wait: 'agent.child', name: `child:${child?.[1] ?? 'itsa'}` };
  if (/New events for your subscription/.test(s)) return { wait: 'event.external', name: 'event' };
  if (/Your permission request/.test(s)) return { wait: 'human.permission', name: 'permission' };
  if (/Your wait for .* timed out/.test(s)) return { wait: 'event.timer', name: 'timer' };
  if (/Stam paused you for cost/.test(s)) return { wait: 'throttle.cost', name: 'unpause' };
  if (/You are no longer paused/.test(s)) return { wait: 'throttle.scheduler', name: 'unpause' };
  const mail = /unread mail[\s\S]*?Latest unread:\s*-\s*\S+ from ([^:\n]+):\s*([^\n]*)/.exec(s);
  if (mail) {
    const from = mail[1].trim();
    if (from === 'the human' || from === 'human') return { wait: 'human.reply', name: 'mail:human' };
    if (from === 'stam' && /^\[stam\] \d+ .* events?\b/.test(mail[2])) return { wait: 'event.external', name: 'event' };
    if (ctx.children.has(from)) return { wait: 'agent.child', name: `mail:${from}` };
    if (ctx.release.has(from)) return { wait: 'agent.release', name: `mail:${from}` };
    return { wait: 'agent.peer', name: `mail:${from}` };
  }
  if (tr.source === 'prompt') return { wait: 'human.prompt', name: 'prompt' };
  if (ctx.timers.some((t) => t <= item.end && t >= item.end - TIMER_SLACK_MS && t >= item.start)) return { wait: 'event.timer', name: 'timer' };
  return { wait: 'idle.none', name: 'notice' };
}

// ---- Ingest -----------------------------------------------------------------------------

export interface IngestResult {
  agent: string;
  items: number;
  error?: string;
}

// Events that mean the agent's turn ended: its harness's end-of-turn hooks, and a resume or
// restart of the harness.
const TURN_ENDS = ['hook:Stop', 'hook:StopFailure', 'hook:SessionEnd', 'opencode:session.execution.succeeded', 'opencode:session.execution.failed', 'opencode:session.execution.interrupted', 'resume', 'spawn'];

function turnEnded(agentId: string, from: number, to?: number): boolean {
  const marks = TURN_ENDS.map(() => '?').join(', ');
  const sql = `SELECT 1 FROM events WHERE agent_id = ? AND type IN (${marks}) AND ts >= ?${to == null ? '' : ' AND ts <= ?'} LIMIT 1`;
  const args = [agentId, ...TURN_ENDS, iso(from), ...(to == null ? [] : [iso(to)])];
  return !!db.open().prepare(sql).get(...args);
}

// Reads what is new in one agent's transcript into activity_items, one transaction per slice
// with the cursor, yielding to the event loop between slices; then rescales its days. Returns
// how many items it added; 0 when the agent's harness has no reader or no turn has ended.
async function ingestNow(agent: db.Agent): Promise<IngestResult> {
  const reader = readers.get(agent.harness);
  if (!reader) return { agent: agent.id, items: 0 };
  const d = db.open();
  const row = d.prepare('SELECT source, offset, state FROM activity_cursors WHERE agent_id = ?').get(agent.id) as { source: string; offset: number; state: string } | undefined;
  const cursor: Cursor | null = row ? { source: row.source, offset: row.offset, state: JSON.parse(row.state) } : null;
  const slices = reader.read(agent, cursor, { turnEnded: (from, to) => turnEnded(agent.id, from, to) });
  if (!slices) return { agent: agent.id, items: 0 };
  let ctx: GapContext | null = null;
  let added = 0;
  for await (const r of slices) {
    if (!ctx && r.items.some((i) => i.kind === 'gap')) ctx = gapContext(agent);
    write(agent.id, r, ctx);
    added += r.items.length;
    await tick();
  }
  rescale(agent.id);
  return { agent: agent.id, items: added };
}

function write(agentId: string, r: ReadResult, ctx: GapContext | null): void {
  const d = db.open();
  // Each message's price, split evenly over the items it produced.
  const byMsg = new Map<string, RawItem[]>();
  for (const it of r.items) if (it.msg) byMsg.set(it.msg, [...(byMsg.get(it.msg) ?? []), it]);
  const share = new Map<RawItem, { cost: number; tin: number; tout: number }>();
  for (const [msg, its] of byMsg) {
    const u = r.usage.get(msg);
    if (!u) continue;
    const cost = u.cost_usd ?? priceUsd(u) ?? 0;
    const tin = u.tokens_in + u.tokens_cache_read + u.tokens_cache_write;
    for (const it of its) share.set(it, { cost: cost / its.length, tin: Math.round(tin / its.length), tout: Math.round(u.tokens_out / its.length) });
  }
  db.transaction(() => {
    let seq = ((d.prepare('SELECT MAX(seq) AS s FROM activity_items WHERE agent_id = ?').get(agentId) as { s: number | null }).s ?? 0) + 1;
    const ins = d.prepare(
      `INSERT INTO activity_items (agent_id, seq, turn, kind, name, start, "end", summary, wait_kind, raw_cost_usd, est_cost_usd, tokens_in, tokens_out, category, category_source, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // By time; items at the same instant by turn, then gap, model, tool, text.
    const rank: Record<ItemKind, number> = { gap: 0, model: 1, tool: 2, text: 3 };
    const sorted = [...r.items].sort((a, b) => a.start - b.start || a.end - b.end || a.turn - b.turn || rank[a.kind] - rank[b.kind]);
    const cls = classifyItems(sorted.map(ruleItem));
    sorted.forEach((it, i) => {
      let name = it.name;
      let wait: string | null = null;
      if (it.kind === 'tool') wait = toolWait(it.name ?? '', it.input, it.end - it.start);
      else if (it.kind === 'model') wait = modelWait(it.end - it.start);
      else if (it.kind === 'gap') ({ wait, name } = gapWait(it, ctx!));
      const s = share.get(it) ?? { cost: 0, tin: 0, tout: 0 };
      const c = cls[i];
      ins.run(agentId, seq++, it.turn, it.kind, name, iso(it.start), iso(it.end), it.summary, wait, s.cost, s.cost, s.tin, s.tout, c.category, c.source, c.confidence);
    });
    d.prepare(
      `INSERT INTO activity_cursors (agent_id, source, offset, state, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET source = excluded.source, offset = excluded.offset, state = excluded.state, updated_at = excluded.updated_at`,
    ).run(agentId, r.cursor.source, r.cursor.offset, JSON.stringify(r.cursor.state), new Date().toISOString());
  });
  touched(agentId, r.items.reduce((m, it) => Math.min(m, it.start), Infinity));
}

function ruleItem(it: RawItem): RuleItem {
  return { kind: it.kind, turn: it.turn, name: it.name, summary: it.summary, input: it.input };
}

// Items per transaction in the backfill (S-213): a long backfill yields to the event loop
// between batches, as ingest does.
const CLASSIFY_BATCH = 2000;

// Classifies the items no rule or model has classified yet (S-213), in the order they happened:
// the backfill for items ingested before the rules, and the same rules as ingest, run again.
// Only rows with no category source are read; a model item's context (its turn's first tool or
// text after it, and whether a text is its turn's last) is read from the rows around it.
export async function classify(agentId: string, batch = CLASSIFY_BATCH): Promise<number> {
  const d = db.open();
  type Row = { seq: number; turn: number; kind: ItemKind; name: string | null; summary: string | null; category: string | null };
  const unset = d.prepare(
    'SELECT seq, turn, kind, name, summary, category FROM activity_items WHERE agent_id = ? AND category_source IS NULL AND seq > ? ORDER BY seq LIMIT ?',
  );
  const laterText = d.prepare("SELECT 1 FROM activity_items WHERE agent_id = ? AND turn = ? AND kind = 'text' AND seq > ? LIMIT 1");
  const sibling = d.prepare(
    "SELECT seq, turn, kind, name, summary, category FROM activity_items WHERE agent_id = ? AND turn = ? AND seq > ? AND kind IN ('tool', 'text') ORDER BY seq LIMIT 1",
  );
  const set = d.prepare('UPDATE activity_items SET category = ?, category_source = ?, confidence = ? WHERE agent_id = ? AND seq = ?');
  // What a tool or text row settles to on its own, with the ingest's rules.
  const own = (r: Row): string | null =>
    classifyByRules(
      { kind: r.kind, turn: r.turn, name: r.name, summary: r.summary },
      { lastInTurn: r.kind === 'text' && !laterText.get(agentId, r.turn, r.seq) },
    )?.category ?? null;
  let n = 0;
  let after = -1;
  for (;;) {
    const rows = unset.all(agentId, after, batch) as Row[];
    if (!rows.length) break;
    after = rows[rows.length - 1].seq;
    db.transaction(() => {
      for (const r of rows) {
        if (r.kind === 'gap') {
          set.run(null, 'derived', 1, agentId, r.seq);
          n++;
        } else if (r.kind === 'model') {
          const s = sibling.get(agentId, r.turn, r.seq) as Row | undefined;
          const c = s ? (s.category ?? own(s)) : null;
          if (c && set.run(c, 'derived', 1, agentId, r.seq).changes) n++;
        } else {
          const c = own(r);
          if (c && set.run(c, 'rule', 1, agentId, r.seq).changes) n++;
        }
      }
    });
    touched(agentId);
    await tick();
  }
  return n;
}

// Classifies one agent by id or name, or every agent with items, in turn.
export async function classifyAll(ref?: string): Promise<{ agent: string; items: number }[]> {
  const agents = ref ? [db.getAgent(ref)].filter((a): a is db.Agent => Boolean(a)) : db.listAgents();
  if (ref && !agents.length) throw new Error(`no agent ${ref}`);
  const out: { agent: string; items: number }[] = [];
  for (const a of agents) out.push({ agent: a.id, items: await classify(a.id) });
  return out;
}

// Sets each of an agent's days so its items' est_cost_usd sums to its usage rows for that
// day, in proportion to raw_cost_usd; a day without usage or without priced items keeps the
// raw estimate. Recomputed from raw every time, so usage that grew since is picked up.
export function rescale(agentId: string): void {
  const d = db.open();
  const days = d
    .prepare('SELECT substr(start, 1, 10) AS day, SUM(raw_cost_usd) AS raw, SUM(est_cost_usd) AS est FROM activity_items WHERE agent_id = ? GROUP BY day')
    .all(agentId) as { day: string; raw: number; est: number }[];
  const used = d.prepare('SELECT SUM(cost_usd) AS s FROM usage WHERE agent_id = ? AND day = ?');
  const set = d.prepare('UPDATE activity_items SET est_cost_usd = raw_cost_usd * ? WHERE agent_id = ? AND start >= ? AND start < ?');
  // The first day whose est cost moved: the activity summary refolds the agent from there.
  let changed: string | null = null;
  db.transaction(() => {
    for (const { day, raw, est } of days) {
      const u = (used.get(agentId, day) as { s: number | null }).s ?? 0;
      const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const f = u > 0 && raw > 0 ? u / raw : 1;
      set.run(f, agentId, day, next);
      if (Math.abs(raw * f - est) > 1e-9 && (changed == null || day < changed)) changed = day;
    }
  });
  if (changed != null) touched(agentId, Date.parse(`${changed}T00:00:00Z`));
}

// Every ingest runs through this queue, one agent at a time, so two triggers for the same
// agent never read the same cursor at once.
let queue: Promise<unknown> = Promise.resolve();

export function ingest(agent: db.Agent): Promise<IngestResult> {
  const run = queue.then(() => {
    const a = db.getAgent(agent.id);
    return a ? ingestNow(a) : { agent: agent.id, items: 0 };
  });
  queue = run.catch(() => {});
  return run;
}

// Ingests one agent by id or name, or every agent with a reader, in turn. Errors are per agent.
export async function ingestAll(ref?: string): Promise<IngestResult[]> {
  const agents = ref ? [db.getAgent(ref)].filter((a): a is db.Agent => Boolean(a)) : db.listAgents();
  if (ref && !agents.length) throw new Error(`no agent ${ref}`);
  const out: IngestResult[] = [];
  for (const a of agents.filter((x) => readers.has(x.harness))) {
    try {
      out.push(await ingest(a));
    } catch (e) {
      out.push({ agent: a.id, items: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

// Ingests every agent in the background, as at daemon start.
export function ingestAllSoon(): void {
  ingestAll().then(
    (rs) => rs.filter((r) => r.error).forEach((r) => db.addEvent(r.agent, 'activity:error', r.error)),
    () => {},
  );
}

// Ingests one agent after its turn ends, off the hook's response path.
export function ingestSoon(agentId: string): void {
  const a = db.getAgent(agentId);
  if (!a) return;
  ingest(a).catch((e) => db.addEvent(agentId, 'activity:error', String(e instanceof Error ? e.message : e)));
}
