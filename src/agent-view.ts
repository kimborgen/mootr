// stam's own view of an agent (S-78): the agent's conversation as structured messages,
// live, beside its tmux terminal, which stays the fallback. Both show one session: the
// harness keeps running in tmux, and this view reads and writes the same session through
// the harness's own interface. Research and data path: docs/agent-view-research.md.
//
// Each harness plugs in a ViewSource (src/adapters/*-view.ts): it reads stored history,
// follows live events into a ViewStore, and sends prompts, interrupts, and permission
// replies where the harness can. Its `capabilities` tell the web what to offer, so a
// read-mostly harness (Claude Code) degrades instead of failing.
//
// Endpoints (src/daemon.ts; an agent on another machine is relayed to its daemon):
//   GET  /api/agents/:id/view                    server-sent events, see ViewEvent
//   GET  /api/agents/:id/view/history?before=MESSAGE_ID&limit=N   older messages: ViewPage
//   GET  /api/agents/:id/view/tools?mail=MAIL_ID   the tool calls before a mail the agent sent (mailTools)
//   POST /api/agents/:id/view/prompt {text, delivery?: 'queue' | 'steer'}
//   POST /api/agents/:id/view/interrupt
//   POST /api/agents/:id/view/permission {request, decision: 'once' | 'always' | 'reject'}
import type { ServerResponse } from 'node:http';
import type { Agent } from './db.ts';
import * as db from './db.ts';

export interface ViewCapabilities {
  can_stream: boolean; // text arrives as it's written, not only when a block ends
  can_send: boolean; // prompts from the view
  can_interrupt: boolean;
  can_approve: boolean; // permission replies from the view
}

export type ToolStatus = 'pending' | 'running' | 'done' | 'error';
export type PermissionDecision = 'once' | 'always' | 'reject';
export type ViewPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; id: string; name: string; input?: unknown; output?: string; status: ToolStatus }
  // A permission request, in the message whose tool asked; `status` 'asked' until answered.
  | { type: 'permission'; id: string; action: string; resources: string[]; tool?: string; status: 'asked' | PermissionDecision }
  // A mail to or from the agent, alone in a user message of kind 'mail' (see withMail).
  // `read_at` is null until the agent reads it; a mail the agent sent has `to` instead, its
  // recipients with each one's read state.
  | { type: 'mail'; id: string; from_id: string; from: string; subject: string; body: string; thread: string; read_at: number | null; to?: MailRecipient[]; kind?: string; health?: string };

export interface MailRecipient {
  id: string;
  name: string;
  read_at: number | null;
}

export interface ViewMessage {
  id: string;
  // 'system': what neither the human nor the model wrote, such as a stam notice, a
  // compaction, or an interrupted turn; `kind` names which.
  role: 'user' | 'assistant' | 'system';
  kind?: string;
  at: number; // ms since the epoch
  // Each part's time, where the harness says: a Claude Code turn (or an OpenCode step) is one
  // message that can run for hours, and the web view splits it at the mail that came in
  // during it (S-255, S-278).
  marks?: number[];
  parts: ViewPart[];
  running?: boolean;
  error?: string;
}

export interface ViewPermission {
  id: string;
  action: string;
  resources: string[];
  message?: string; // the message holding its permission part
  tool?: string;
}

export interface ViewState {
  agent: string;
  harness: string;
  capabilities: ViewCapabilities;
  running: boolean;
  messages: ViewMessage[]; // oldest first; the newest page only
  permissions: ViewPermission[]; // waiting for an answer
  older: string | null; // `before` for /view/history: the oldest message's id, null at the start
}

export type ViewEvent =
  | { type: 'state'; state: ViewState } // first, and after the stream lost track
  | { type: 'message'; message: ViewMessage } // one message created or changed, whole
  | { type: 'status'; running: boolean; permissions: ViewPermission[] };

// Messages oldest first, the newest `limit` of those before message `before`; `older` as in ViewState.
export interface ViewPage {
  messages: ViewMessage[];
  older: string | null;
}

// What a harness plugs in. `follow` calls `live.changed()` after it changes `live.store`,
// and `live.resync()` when the harness's stored messages are worth re-reading.
export interface ViewSource {
  capabilities: ViewCapabilities;
  // Why this agent has no view right now, or null when it has one.
  unavailable(a: Agent): string | null;
  page(a: Agent, opts: { limit: number; before?: string }): Promise<ViewPage>;
  status(a: Agent): Promise<{ running: boolean; permissions: ViewPermission[] }>;
  follow(a: Agent, live: LiveSink): () => void;
  prompt?(a: Agent, text: string, delivery: 'queue' | 'steer'): Promise<void>;
  interrupt?(a: Agent): Promise<boolean>;
  answerPermission?(a: Agent, request: string, decision: PermissionDecision): Promise<void>;
}

export interface LiveSink {
  store: ViewStore;
  changed(): void;
  resync(): void;
}

// The live window of one agent's conversation, changed in place by a normalizer. It
// remembers what changed since the last flush.
export class ViewStore {
  messages: ViewMessage[] = [];
  permissions: ViewPermission[] = [];
  running = false;
  dirty = new Set<string>();
  statusDirty = false;
  hasOlder = false; // the harness has messages older than the window
  // Set when the harness's transcript moved: the window was emptied and every client gets the state whole.
  replaced = false;
  // Where a streamed part sits in its message. Keys: `text:N` and `reasoning:N` for the
  // message's Nth part of that type (from 0), `tool:ID` and `permission:ID` by id. A
  // normalizer must use these keys, so a merge can rebuild them from the parts.
  private slots = new Map<string, Map<string, number>>();

  message(id: string, make: () => ViewMessage = () => ({ id, role: 'assistant', at: Date.now(), parts: [], running: true })): ViewMessage {
    let m = this.messages.find((x) => x.id === id);
    if (!m) this.messages.push((m = make()));
    this.dirty.add(id);
    return m;
  }

  // The part under `key` in message `msgId`, made with `make` the first time.
  part<P extends ViewPart>(msgId: string, key: string, make: () => P): P {
    const m = this.message(msgId);
    let s = this.slots.get(msgId);
    if (!s) this.slots.set(msgId, (s = new Map()));
    let i = s.get(key);
    if (i === undefined || !m.parts[i]) {
      i = m.parts.push(make()) - 1;
      s.set(key, i);
    }
    return m.parts[i] as P;
  }

  setRunning(running: boolean): void {
    if (this.running !== running) this.statusDirty = true;
    this.running = running;
  }

  ask(p: ViewPermission): void {
    if (!this.permissions.some((x) => x.id === p.id)) this.permissions.push(p);
    this.statusDirty = true;
    if (p.message) this.part(p.message, `permission:${p.id}`, () => ({ type: 'permission', id: p.id, action: p.action, resources: p.resources, tool: p.tool, status: 'asked' }));
  }

  answered(id: string, decision: PermissionDecision): void {
    const p = this.permissions.find((x) => x.id === id);
    this.permissions = this.permissions.filter((x) => x.id !== id);
    this.statusDirty = true;
    const m = p?.message ? this.messages.find((x) => x.id === p.message) : this.messages.find((x) => x.parts.some((q) => q.type === 'permission' && q.id === id));
    const part = m?.parts.find((q) => q.type === 'permission' && q.id === id);
    if (m && part?.type === 'permission') {
      part.status = decision;
      this.dirty.add(m.id);
    }
  }

  // Replaces the window's messages with a fresh read of the newest page, keeping what the
  // read can't have yet: messages still streaming, and the permission parts of messages
  // the harness doesn't store them in. Marks only messages that changed.
  merge(fresh: ViewMessage[]): void {
    const old = new Map(this.messages.map((m) => [m.id, m]));
    const ids = new Set(fresh.map((m) => m.id));
    // The page's oldest harness message: mail is the view's own and can be older.
    const oldest = Math.min(...fresh.filter((m) => m.kind !== 'mail').map((m) => m.at));
    const keep = this.messages.filter((m) => !ids.has(m.id) && (m.running || m.at < oldest));
    for (const m of fresh) {
      const prev = old.get(m.id);
      for (const p of prev?.parts ?? []) if (p.type === 'permission' && !m.parts.some((q) => q.type === 'permission' && q.id === p.id)) m.parts.push(p);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(m)) this.dirty.add(m.id);
    }
    const all = [...keep, ...fresh];
    // Only harness messages count against the window; mail comes along for their time span.
    let harness = all.filter((m) => m.kind !== 'mail').sort((a, b) => a.at - b.at);
    let mail = all.filter((m) => m.kind === 'mail');
    if (harness.length > MAX_WINDOW) {
      harness = harness.slice(-MAX_WINDOW);
      mail = mail.filter((m) => m.at >= harness[0].at);
      this.hasOlder = true;
    }
    this.messages = interleave([...harness, ...mail]);
    this.slots.clear();
    for (const m of this.messages) this.slots.set(m.id, slotsOf(m));
  }

  // The oldest harness message: a mail message is the view's own, so the harness can't page from it.
  get older(): string | null {
    return this.hasOlder ? (this.messages.find((m) => m.kind !== 'mail')?.id ?? null) : null;
  }

  // What changed since the last flush, and forgets it.
  flush(): ViewEvent[] {
    const out: ViewEvent[] = [];
    for (const id of this.dirty) {
      const m = this.messages.find((x) => x.id === id);
      if (m) out.push({ type: 'message', message: m });
    }
    if (this.statusDirty) out.push({ type: 'status', running: this.running, permissions: this.permissions });
    this.dirty.clear();
    this.statusDirty = false;
    return out;
  }
}

// The slot keys of a message's parts (see ViewStore.slots).
function slotsOf(m: ViewMessage): Map<string, number> {
  const out = new Map<string, number>();
  const nth: Record<string, number> = {};
  m.parts.forEach((p, i) => {
    const key = p.type === 'text' || p.type === 'reasoning' ? `${p.type}:${(nth[p.type] = (nth[p.type] ?? -1) + 1)}` : `${p.type}:${p.id}`;
    if (!out.has(key)) out.set(key, i);
  });
  return out;
}

// Mail to and from the agent joins its conversation as user messages of kind 'mail', at the
// time it was sent, from the daemon's mail table: the harness only ever sees a notice listing
// it, the result of its read_mail call, and its own send_mail call. A page of harness messages
// carries the mail from its first message (from the start when nothing is older) up to
// `until`, where the next newer page starts.
export function withMail(a: Agent, messages: ViewMessage[], older: boolean, until = Infinity): ViewMessage[] {
  const from = older && messages.length ? messages[0].at : 0;
  const iso = (ms: number) => new Date(ms).toISOString();
  const end = Number.isFinite(until) ? iso(until) : '9999';
  const mail = [...db.mailTo(a.id, iso(from), end).map(mailMessage), ...db.mailBy(a.id, iso(from), end).map(sentMessage)];
  return mail.length ? interleave([...messages, ...mail]) : messages;
}

// Mail among harness messages, which keep their order: a mail goes above the first harness
// message that started after it was sent; a mail and a harness message at the same time keep
// the harness's first. The web view orders the same way, and also splits a turn whose parts
// carry their times (`marks`) at the mail sent during it (web/src/views/ownview-model.ts).
export function interleave(messages: ViewMessage[]): ViewMessage[] {
  const mail = messages.filter((m) => m.kind === 'mail').sort((x, y) => x.at - y.at);
  const out: ViewMessage[] = [];
  let i = 0;
  for (const h of messages) {
    if (h.kind === 'mail') continue;
    while (i < mail.length && mail[i].at < h.at) out.push(mail[i++]);
    out.push(h);
  }
  return [...out, ...mail.slice(i)];
}

const nameOf = (id: string) => (id === 'human' ? 'human' : (db.getAgent(id)?.name ?? id));

function mailMessage(m: db.Mail): ViewMessage {
  const from = m.from_name ?? nameOf(m.from_id);
  return {
    id: `mail:${m.id}`,
    role: 'user',
    kind: 'mail',
    at: Date.parse(m.created_at),
    parts: [{ type: 'mail', id: m.id, from_id: m.from_id, from, subject: m.subject, body: m.body, thread: m.thread_id ?? m.id, read_at: m.read_at ? Date.parse(m.read_at) : null, ...(m.kind ? { kind: m.kind } : {}), ...(m.health ? { health: m.health } : {}) }],
  };
}

// A mail the agent sent: the same card, with its recipients in place of its own read state.
function sentMessage(m: db.Mail & { to: { id: string; read_at: string | null }[] }): ViewMessage {
  const msg = mailMessage(m);
  const part = msg.parts[0] as Extract<ViewPart, { type: 'mail' }>;
  part.to = m.to.map((r) => ({ id: r.id, name: nameOf(r.id), read_at: r.read_at ? Date.parse(r.read_at) : null }));
  return msg;
}

const PAGE = 50;
const MAX_WINDOW = 400;
const sources: Record<string, ViewSource> = {};

export function register(harness: string, source: ViewSource): void {
  sources[harness] = source;
}

export class ViewError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sourceFor(a: Agent): ViewSource {
  const s = sources[a.harness];
  if (!s) throw new ViewError(409, `stam's own view doesn't support ${a.harness} yet; use the terminal`);
  const why = s.unavailable(a);
  if (why) throw new ViewError(409, why);
  return s;
}

// What the agent's view offers, for the agent's JSON: null when it has none.
export function capabilities(a: Agent): ViewCapabilities | null {
  const s = sources[a.harness];
  return s && !s.unavailable(a) ? s.capabilities : null;
}

// One per agent with a view open in any browser; dropped when the last one closes.
interface Live extends LiveSink {
  agent: Agent;
  source: ViewSource;
  clients: Set<ServerResponse>;
  ready: Promise<void>;
  joining: number; // clients still waiting for the first read
  stop?: () => void;
  timer?: NodeJS.Timeout;
  rereading?: NodeJS.Timeout;
}
const lives = new Map<string, Live>();
// A mail to an agent, or its reading it, re-reads its open view, which brings the mail in.
db.onAgentMail((agents) => {
  for (const id of agents) lives.get(id)?.resync();
});

// A client that reads slower than the agent writes would buffer whole messages without
// bound: past this it's dropped, and reconnecting gets it a fresh `state`.
const MAX_BUFFERED = 4 * 1024 * 1024;
function write(res: ServerResponse, text: string): void {
  if (res.destroyed) return;
  if (res.writableLength > MAX_BUFFERED) return void res.destroy();
  res.write(text);
}
const send = (res: ServerResponse, ev: ViewEvent) => write(res, `data: ${JSON.stringify(ev)}\n\n`);

function stateOf(l: Live): ViewState {
  const { store } = l;
  return { agent: l.agent.id, harness: l.agent.harness, capabilities: l.source.capabilities, running: store.running, messages: store.messages, permissions: store.permissions, older: store.older };
}

// Changes go out at most every 50 ms, so a burst of deltas costs one write per message.
const FLUSH_MS = 50;

function openLive(a: Agent, source: ViewSource): Live {
  const store = new ViewStore();
  const l: Live = {
    agent: a,
    source,
    store,
    clients: new Set(),
    joining: 0,
    ready: Promise.resolve(),
    changed() {
      l.timer ??= setTimeout(() => {
        l.timer = undefined;
        if (store.replaced) {
          store.replaced = false;
          store.flush();
          for (const r of l.clients) send(r, { type: 'state', state: stateOf(l) });
          return;
        }
        for (const ev of store.flush()) for (const r of l.clients) send(r, ev);
      }, FLUSH_MS);
    },
    // The harness's stored messages are the truth: a re-read replaces what the deltas built.
    resync() {
      clearTimeout(l.rereading);
      l.rereading = setTimeout(async () => {
        try {
          const [page, st] = await Promise.all([source.page(l.agent, { limit: PAGE }), source.status(l.agent)]);
          store.merge(withMail(l.agent, page.messages, page.older !== null));
          store.setRunning(st.running);
          const waiting = new Set(st.permissions.map((x) => x.id));
          store.permissions = store.permissions.filter((x) => waiting.has(x.id));
          for (const x of st.permissions) store.ask(x);
          store.statusDirty = true;
          l.changed();
        } catch {}
      }, 100);
    },
  };
  // Live events start before the first read, so nothing between the two is lost; the read
  // then merges under them.
  l.stop = source.follow(a, l);
  return l;
}

export async function stream(a: Agent, res: ServerResponse): Promise<void> {
  const source = sourceFor(a);
  let l = lives.get(a.id);
  const fresh = !l;
  if (!l) {
    const live = (l = openLive(a, source));
    lives.set(a.id, live);
    live.ready = (async () => {
      const [p, st] = await Promise.all([source.page(a, { limit: PAGE }), source.status(a)]);
      live.store.merge(withMail(a, p.messages, p.older !== null));
      live.store.hasOlder = p.older !== null;
      live.store.setRunning(st.running);
      for (const perm of st.permissions) live.store.ask(perm);
      live.store.flush();
    })();
  }
  const live = l;
  // A client that leaves while the first read is pending must not be attached after it.
  let closed = false;
  let ping: NodeJS.Timeout | undefined;
  res.on('close', () => {
    closed = true;
    clearInterval(ping);
    live.clients.delete(res);
    release(live);
  });
  live.joining++;
  try {
    await live.ready;
  } catch (e) {
    if (fresh && lives.get(a.id) === live) drop(live);
    throw new ViewError(502, `can't read ${a.name}'s conversation: ${e instanceof Error ? e.message : e}`);
  } finally {
    live.joining--;
  }
  if (closed || res.destroyed) return release(live);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  live.clients.add(res);
  send(res, { type: 'state', state: stateOf(live) });
  ping = setInterval(() => write(res, ': ping\n\n'), 25_000);
}

// How many agents have a view open, for tests.
export const openViews = (): number => lives.size;

// Whether a web client has the agent's view open right now.
export const hasViewers = (agentId: string): boolean => (lives.get(agentId)?.clients.size ?? 0) > 0;

// Drops the live window once no client has it open or is joining.
function release(l: Live): void {
  if (!l.clients.size && !l.joining && lives.get(l.agent.id) === l) drop(l);
}

function drop(l: Live): void {
  lives.delete(l.agent.id);
  l.stop?.();
  clearTimeout(l.timer);
  clearTimeout(l.rereading);
}

export async function history(a: Agent, before: string | undefined, limit = PAGE): Promise<ViewPage> {
  const page = await sourceFor(a).page(a, { before, limit: Math.min(Math.max(Math.floor(limit) || PAGE, 1), 200) });
  // The page's mail ends where the newer page starts; when the view isn't open here that
  // time is unknown, and the client drops the mail it already has.
  const until = before ? (lives.get(a.id)?.store.messages.find((m) => m.id === before)?.at ?? Infinity) : Infinity;
  return { ...page, messages: withMail(a, page.messages, page.older !== null, until) };
}

// The tool calls an agent made on the way to a mail it sent (S-1643), for the ITSA thread's drawer.
// Its turn starts at the newest boundary before the mail: an input (a mail to the agent, the
// human's message, a stam notice) or a mail the agent sent. A tool call belongs to the turn when
// it came after that boundary and at or before the mail; its time is its part's mark where the
// harness gives one, else its message's. A turn with no boundary before the mail runs from the
// transcript's start. Pure over the messages read so far: `done` once the boundary (or the start) is in.
export type ToolCall = Extract<ViewPart, { type: 'tool' }>;
export function turnTools(messages: ViewMessage[], hi: number): { tools: ToolCall[]; done: boolean } {
  const events: { at: number; tool?: ToolCall }[] = [];
  for (const m of messages) {
    if (m.kind === 'mail') {
      // A mail the agent received starts its turn when the agent read it (its read_at); unread, it started none.
      const p = m.parts[0];
      if (p?.type === 'mail' && !p.to) {
        if (p.read_at !== null) events.push({ at: p.read_at });
      } else events.push({ at: m.at });
    } else if (m.role === 'user' || (m.role === 'system' && m.kind === 'notice')) events.push({ at: m.at });
    else m.parts.forEach((p, k) => p.type === 'tool' && events.push({ at: m.marks?.[k] ?? m.at, tool: p }));
  }
  // Newest first; at the same time a boundary comes before a call, so a call at the boundary's time is the next turn's.
  const newest = events.filter((e) => (e.tool ? e.at <= hi : e.at < hi)).sort((a, b) => b.at - a.at || Number(!!a.tool) - Number(!!b.tool));
  const tools: ToolCall[] = [];
  for (const e of newest) {
    if (!e.tool) return { tools: tools.reverse(), done: true };
    tools.push(e.tool);
  }
  return { tools: tools.reverse(), done: false };
}

const TOOL_PAGE = 50;
const TOOL_PAGES = 40;
// The slice of one mail the agent sent (see turnTools): pages of its view are read newest first until the turn's start
// is in. Each page's mail ends where the page before it starts, so no page reads mail past its own range. `truncated`
// says the page cap ran out before the turn's start, so the slice is not the whole turn.
export async function mailTools(a: Agent, mailId: string): Promise<{ tools: ToolCall[]; truncated: boolean }> {
  const mail = db.getMail(mailId);
  if (!mail || mail.from_id !== a.id) throw new ViewError(404, `${a.name} sent no mail ${mailId}`);
  const source = sourceFor(a);
  const hi = Date.parse(mail.created_at);
  const seen = new Map<string, ViewMessage>();
  let before: string | undefined;
  let until = Infinity;
  for (let page = 0; ; page++) {
    const p = await source.page(a, { before, limit: TOOL_PAGE });
    for (const m of withMail(a, p.messages, p.older !== null, until)) seen.set(m.id, m);
    // A received mail is a boundary at its read_at, which can fall in this page's range though it was created on an older
    // page: add the mail read in the range, so an early stop can't miss a later boundary.
    const from = p.older !== null && p.messages.length ? p.messages[0].at : 0;
    // Bounded by the target mail's time in SQL, before the row cap: reads at or after it are no boundary (turnTools drops them).
    const to = Math.min(until, hi);
    const iso = (ms: number) => new Date(ms).toISOString();
    for (const m of db.mailReadIn(a.id, iso(from), iso(to)).map(mailMessage)) seen.set(m.id, m);
    const slice = turnTools([...seen.values()], hi);
    if (slice.done || !p.older) return { tools: slice.tools, truncated: false };
    if (page + 1 >= TOOL_PAGES) return { tools: slice.tools, truncated: true };
    until = p.messages[0]?.at ?? until;
    before = p.older;
  }
}

export async function prompt(a: Agent, text: string, delivery: 'queue' | 'steer' = 'queue'): Promise<void> {
  const s = sourceFor(a);
  if (!s.capabilities.can_send || !s.prompt) throw new ViewError(409, `${a.harness} takes no prompts from the view; use the terminal`);
  if (!text.trim()) throw new ViewError(400, 'text is empty');
  if (delivery !== 'queue' && delivery !== 'steer') throw new ViewError(400, "delivery is 'queue' or 'steer'");
  await s.prompt(a, text, delivery);
  db.addEvent(a.id, 'view-prompt', { delivery, chars: text.length });
}

export async function interrupt(a: Agent): Promise<boolean> {
  const s = sourceFor(a);
  if (!s.capabilities.can_interrupt || !s.interrupt) throw new ViewError(409, `${a.harness} can't be interrupted from the view; use the terminal`);
  db.addEvent(a.id, 'view-interrupt', {});
  return s.interrupt(a);
}

export async function answerPermission(a: Agent, request: string, decision: PermissionDecision): Promise<void> {
  const s = sourceFor(a);
  if (!s.capabilities.can_approve || !s.answerPermission) throw new ViewError(409, `${a.harness} takes no permission replies from the view; use the terminal`);
  if (!request) throw new ViewError(400, 'request is missing');
  if (!['once', 'always', 'reject'].includes(decision)) throw new ViewError(400, "decision is 'once', 'always', or 'reject'");
  await s.answerPermission(a, request, decision);
  db.addEvent(a.id, 'view-permission', { request, decision });
}
