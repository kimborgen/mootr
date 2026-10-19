// A Claude Code transcript (JSONL) parsed into view messages, read in place (S-1580: split from
// claude-view.ts). It imports only node:fs and types, so the turn reader's worker thread
// (turn-read-worker.ts) parses with it off the daemon's event loop.
import { statSync, openSync, readSync, closeSync } from 'node:fs';
import type { ViewMessage, ViewPart, ToolStatus } from '../agent-view.ts';

const CHUNK = 1 << 20;

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c?.type === 'text' ? String(c.text ?? '') : '')).filter(Boolean).join('\n');
};

type Tool = { owner: string; part: Extract<ViewPart, { type: 'tool' }> };

// One transcript, read in place: rows appended since the last read are folded into the same
// messages. A turn is one message: consecutive assistant rows, across the tool results
// between them, until the next user prompt. A tool result fills the tool part it answers.
// Shared by page() and follow(): `watchers` counts the followers, whose changed messages
// queue in `pending` for them to take, so a read by a page doesn't hide a change from a follow.
export class Transcript {
  messages: ViewMessage[] = [];
  byId = new Map<string, ViewMessage>();
  watchers = 0;
  // Counts the times the file was replaced by a shorter one, so a follower can notice.
  resets = 0;
  private pos = 0;
  private carry = Buffer.alloc(0);
  private tools = new Map<string, Tool>();
  private group: ViewMessage | null = null;
  private pending = new Set<string>();

  readonly file: string;

  // `from` starts the read mid-file, at a byte offset: the row it lands in is cut and skipped, and
  // a tool result whose call came before it is dropped.
  constructor(file: string, from = 0) {
    this.file = file;
    this.pos = from;
  }

  // How far the file is read, in bytes.
  get position(): number {
    return this.pos;
  }

  // Reads what was appended. A file replaced by a shorter one is rebuilt from its start, and
  // `resets` goes up.
  read(): { touched: Set<string>; reset: boolean } {
    const touched = new Set<string>();
    let reset = false;
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return { touched, reset };
    }
    if (size < this.pos) {
      this.clear();
      this.resets++;
      reset = true;
    }
    if (size === this.pos) return { touched, reset };
    const fd = openSync(this.file, 'r');
    try {
      let pos = this.pos;
      while (pos < size) {
        const len = Math.min(CHUNK, size - pos);
        const buf = Buffer.allocUnsafe(len);
        const n = readSync(fd, buf, 0, len, pos);
        if (n <= 0) break;
        pos += n;
        const data = this.carry.length ? Buffer.concat([this.carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        let start = 0;
        for (let nl = data.indexOf(0x0a, start); nl >= 0; nl = data.indexOf(0x0a, start)) {
          const line = data.subarray(start, nl).toString('utf8');
          start = nl + 1;
          if (line.trim()) this.line(line, touched);
        }
        this.carry = Buffer.from(data.subarray(start)); // a partial line waits for its newline
      }
      this.pos = pos;
    } finally {
      closeSync(fd);
    }
    if (this.watchers) for (const id of touched) this.pending.add(id);
    return { touched, reset };
  }

  // The ids of messages changed since the last take, for a follower; forgets them.
  take(): string[] {
    const ids = [...this.pending];
    this.pending.clear();
    return ids;
  }

  private clear(): void {
    this.pos = 0;
    this.carry = Buffer.alloc(0);
    this.messages = [];
    this.byId.clear();
    this.tools.clear();
    this.group = null;
    this.pending.clear();
  }

  private line(text: string, touched: Set<string>): void {
    let e: any;
    try {
      e = JSON.parse(text);
    } catch {
      return; // a line Claude Code didn't finish writing, or one it never will
    }
    if (e?.isSidechain) return; // a subagent's rows aren't the conversation
    const at = Date.parse(e?.timestamp) || 0;
    const id = String(e?.uuid ?? e?.message?.id ?? '');
    const content = e?.message?.content;
    // A turn ends where Claude Code records its duration (S-278): the next rows are a new turn.
    if (e?.type === 'system' && e.subtype === 'turn_duration') return void (this.group = null);
    // A stam notice that woke the agent (a channel message) starts a new turn, shown as a
    // notice row; other meta rows (hook context) aren't the conversation.
    if (e?.type === 'user' && e.isMeta && e.origin?.kind === 'channel') return this.notice(id, at, textOf(content), touched);
    if (e?.isMeta) return;
    if (e?.type === 'user') {
      if (typeof content === 'string') return this.prompt(id, at, content, touched);
      if (!Array.isArray(content)) return;
      for (const b of content) if (b?.type === 'tool_result') this.result(b, touched);
      const text = textOf(content.filter((b) => b?.type === 'text'));
      if (text) this.prompt(id, at, text, touched);
    } else if (e?.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) this.block(b, id, at, touched);
    }
  }

  private add(m: ViewMessage, touched: Set<string>): void {
    this.messages.push(m);
    this.byId.set(m.id, m);
    touched.add(m.id);
  }

  private prompt(id: string, at: number, text: string, touched: Set<string>): void {
    this.group = null;
    if (text) this.add({ id, role: 'user', at, parts: [{ type: 'text', text }] }, touched);
  }

  private notice(id: string, at: number, text: string, touched: Set<string>): void {
    this.group = null;
    text = text.replace(/<\/?channel\b[^>]*>/g, '').trim();
    if (text) this.add({ id, role: 'system', kind: 'notice', at, parts: [{ type: 'text', text }] }, touched);
  }

  private result(b: any, touched: Set<string>): void {
    const t = this.tools.get(String(b.tool_use_id));
    if (!t) return;
    t.part.output = textOf(b.content);
    t.part.status = b.is_error ? 'error' : 'done';
    touched.add(t.owner);
  }

  private block(b: any, id: string, at: number, touched: Set<string>): void {
    let part: ViewPart;
    if (b?.type === 'text') {
      const text = String(b.text ?? '');
      if (!text) return;
      part = { type: 'text', text };
    } else if (b?.type === 'thinking') {
      // Claude Code stores thinking empty; a reasoning part exists only when it has text.
      const text = String(b.thinking ?? '');
      if (!text) return;
      part = { type: 'reasoning', text };
    } else if (b?.type === 'tool_use') {
      const tool: Extract<ViewPart, { type: 'tool' }> = { type: 'tool', id: String(b.id), name: String(b.name), input: b.input, status: 'pending' as ToolStatus };
      part = tool;
      if (!this.group) this.startGroup(id, at, touched);
      this.tools.set(tool.id, { owner: this.group!.id, part: tool });
    } else return;
    if (!this.group) this.startGroup(id, at, touched);
    this.group!.parts.push(part);
    this.group!.marks!.push(at);
    touched.add(this.group!.id);
  }

  private startGroup(id: string, at: number, touched: Set<string>): void {
    this.group = { id, role: 'assistant', at, parts: [], marks: [] };
    this.add(this.group, touched);
  }
}
