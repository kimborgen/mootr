// Codex's part of stam's own agent view (src/agent-view.ts): stored history from the agent's
// thread (`thread/read` with turns), live items and deltas from the daemon's one connection
// to the agent's app-server (codex.ts `listen`), and prompts, interrupts, and approval
// replies through the same connection. Every one of them shows in the agent's TUI too.
// Methods and fields as codex-cli 0.162.1's protocol says (`codex app-server
// generate-json-schema`), not guesses.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { Agent } from '../db.ts';
import * as db from '../db.ts';
import { ViewError } from '../agent-view.ts';
import type { LiveSink, ViewMessage, ViewPart, ViewPermission, ViewSource, ToolStatus, PermissionDecision, ViewStore } from '../agent-view.ts';
import { codex, listen, appServer, answerRequest, openRequests, steerPrompt } from './codex.ts';

const toolStatus = (s: string | undefined): ToolStatus => (s === 'completed' ? 'done' : s === 'failed' || s === 'declined' ? 'error' : s === 'inProgress' ? 'running' : 'pending');
const textOfInputs = (content: any[] | undefined): string => (content ?? []).map((c) => (c?.type === 'text' ? String(c.text ?? '') : '')).join('');

// One thread item as a view message, or null for one the view leaves out (plans, searches,
// and the like). `running` is whether the item's turn is still going.
export function fromItem(item: any, at: number, running: boolean): ViewMessage | null {
  const id = String(item.id);
  const assistant = (parts: ViewPart[]): ViewMessage => ({ id, role: 'assistant', at, parts, ...(running ? { running: true } : {}) });
  switch (item.type) {
    case 'userMessage':
      return { id, role: 'user', at, parts: [{ type: 'text', text: textOfInputs(item.content) }] };
    case 'agentMessage':
      return assistant([{ type: 'text', text: String(item.text ?? '') }]);
    case 'reasoning': {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].join('\n');
      return assistant(text ? [{ type: 'reasoning', text }] : []);
    }
    case 'commandExecution':
      return assistant([{ type: 'tool', id, name: 'shell', input: { command: item.command, cwd: item.cwd }, output: item.aggregatedOutput ?? undefined, status: toolStatus(item.status) }]);
    case 'fileChange': {
      const changes: any[] = item.changes ?? [];
      return assistant([{ type: 'tool', id, name: 'apply_patch', input: { paths: changes.map((c) => c.path) }, output: changes.map((c) => c.diff).join('\n'), status: toolStatus(item.status) }]);
    }
    case 'mcpToolCall':
      return assistant([{ type: 'tool', id, name: `${item.server}.${item.tool}`, input: item.arguments, output: item.result ? JSON.stringify(item.result.content ?? item.result) : item.error?.message, status: toolStatus(item.status) }]);
    case 'dynamicToolCall':
      return assistant([{ type: 'tool', id, name: item.tool, input: item.arguments, output: (item.contentItems ?? []).map((c: any) => c.text ?? '').join(''), status: item.success === false ? 'error' : toolStatus(item.status) }]);
    case 'contextCompaction':
      return { id, role: 'system', kind: 'compaction', at, parts: [{ type: 'text', text: 'Compacted' }] };
  }
  return null;
}

// When each item of a thread started, by item id, from the thread's rollout file (its
// `path`): thread/read's items carry no time, and a turn can run for hours while mail comes
// in, so the view needs each item's own time to put the mail where it came (S-278). Rows
// appended since the last read are read; a file replaced by a shorter one is read again.
const CHUNK = 1 << 20;
const rollouts = new Map<string, { pos: number; carry: Buffer; times: Map<string, number> }>();
export function itemTimes(path: string | undefined): Map<string, number> {
  if (!path) return new Map();
  let r = rollouts.get(path);
  if (!r) {
    if (rollouts.size >= 16) rollouts.delete(rollouts.keys().next().value!);
    rollouts.set(path, (r = { pos: 0, carry: Buffer.alloc(0), times: new Map() }));
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return r.times;
  }
  if (size < r.pos) Object.assign(r, { pos: 0, carry: Buffer.alloc(0), times: new Map() });
  if (size === r.pos) return r.times;
  // In chunks, as a rollout can run to hundreds of MB; only item_completed rows are parsed.
  const fd = openSync(path, 'r');
  try {
    while (r.pos < size) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - r.pos));
      const n = readSync(fd, buf, 0, buf.length, r.pos);
      if (n <= 0) break;
      r.pos += n;
      const data = r.carry.length ? Buffer.concat([r.carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (let nl = data.indexOf(0x0a); nl >= 0; nl = data.indexOf(0x0a, start)) {
        const line = data.subarray(start, nl);
        start = nl + 1;
        if (line.indexOf('"item_completed"') < 0) continue;
        try {
          const e = JSON.parse(line.toString('utf8'));
          const p = e.payload;
          if (p?.type === 'item_completed' && p.item?.id) r.times.set(String(p.item.id), Number(p.started_at_ms) || Date.parse(e.timestamp) || 0);
        } catch {}
      }
      r.carry = Buffer.from(data.subarray(start)); // a partial line waits for its newline
    }
  } finally {
    closeSync(fd);
  }
  return r.times;
}

// Puts a whole message into the store: created once, then its parts updated in place (a
// tool part by its id, text and reasoning by their one slot), keeping what the item doesn't say.
function upsert(store: ViewStore, m: ViewMessage): void {
  const cur = store.message(m.id, () => ({ id: m.id, role: m.role, kind: m.kind, at: m.at, parts: [], running: m.running }));
  cur.running = m.running;
  if (m.kind) cur.kind = m.kind;
  for (const p of m.parts) {
    const key = p.type === 'tool' ? `tool:${p.id}` : `${p.type}:0`;
    const part = store.part<any>(m.id, key, () => ({ ...p }));
    for (const [k, v] of Object.entries(p)) if (v !== undefined) part[k] = v;
  }
}

// Approval replies: the view's decision, as the app-server's decision for the request.
const DECISION: Record<PermissionDecision, string> = { once: 'accept', always: 'acceptForSession', reject: 'decline' };
const APPROVALS: Record<string, 'shell' | 'edit'> = { 'item/commandExecution/requestApproval': 'shell', 'item/fileChange/requestApproval': 'edit' };
// The decision this view sent, by request, for the resolution that follows it.
const decided = new Map<string, PermissionDecision>();
// A request as a permission: a command's command line, or a file change's write root.
const permissionOf = (id: string | number, method: string, p: any): ViewPermission => {
  const resource = p.command ?? p.grantRoot;
  return { id: String(id), action: APPROVALS[method], resources: resource ? [String(resource)] : [], message: p.itemId, tool: p.itemId };
};

// Reasoning text as it streams, by agent and item: summary and content parts by index.
const reasoning = new Map<string, { summary: string[]; content: string[] }>();

// The agent's own thread's session id: subagents' turns, items, and approvals are not the view's.
const ownThread = (a: Agent) => db.getAgent(a.id)?.session_id ?? a.session_id;
const ours = (a: Agent, threadId: string | undefined) => {
  const sid = ownThread(a);
  return !sid || threadId === sid;
};

function onNote(a: Agent, live: LiveSink, method: string, p: any): void {
  const { store } = live;
  const mine = (t: string | undefined) => ours(a, t);
  switch (method) {
    case 'turn/started':
      if (!mine(p.threadId)) return;
      store.setRunning(true);
      return live.changed();
    case 'turn/completed':
      if (!mine(p.threadId)) return;
      store.setRunning(false);
      for (const m of store.messages) if (m.running) (m.running = false), store.dirty.add(m.id);
      live.changed();
      return live.resync();
    case 'thread/status/changed':
      if (!mine(p.threadId)) return;
      if (p.status?.type === 'idle') store.setRunning(false);
      if (p.status?.type === 'active') store.setRunning(true);
      return live.changed();
    case 'item/started':
    case 'item/completed': {
      if (!mine(p.threadId)) return;
      if (method === 'item/completed') reasoning.delete(`${a.id}:${p.item?.id}`);
      const m = fromItem(p.item, Date.now(), method === 'item/started');
      if (m) upsert(store, m);
      return live.changed();
    }
    case 'item/agentMessage/delta':
      if (!mine(p.threadId)) return;
      store.part(p.itemId, 'text:0', () => ({ type: 'text', text: '' })).text += p.delta ?? '';
      return live.changed();
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      if (!mine(p.threadId)) return;
      // Summary parts first, then content parts, each by its index, as fromItem renders them.
      const key = `${a.id}:${p.itemId}`;
      const buf = reasoning.get(key) ?? { summary: [], content: [] };
      reasoning.set(key, buf);
      const list = method.endsWith('summaryTextDelta') ? buf.summary : buf.content;
      const i = method.endsWith('summaryTextDelta') ? p.summaryIndex : p.contentIndex;
      list[i] = (list[i] ?? '') + (p.delta ?? '');
      store.part(p.itemId, 'reasoning:0', () => ({ type: 'reasoning', text: '' })).text = [...buf.summary, ...buf.content].join('\n');
      return live.changed();
    }
    case 'item/commandExecution/outputDelta':
    case 'item/fileChange/outputDelta': {
      if (!mine(p.threadId)) return;
      const t = store.part<Extract<ViewPart, { type: 'tool' }>>(p.itemId, `tool:${p.itemId}`, () => ({ type: 'tool', id: p.itemId, name: method.includes('fileChange') ? 'apply_patch' : 'shell', status: 'running' }));
      t.output = (t.output ?? '') + (p.delta ?? '');
      return live.changed();
    }
    case 'serverRequest/resolved': {
      if (!mine(p.threadId)) return;
      const key = `${a.id}:${p.requestId}`;
      // Answered by another client (the TUI), the decision isn't in the notification: 'once'.
      store.answered(String(p.requestId), decided.get(key) ?? 'once');
      decided.delete(key);
      return live.changed();
    }
  }
}

export const codexView: ViewSource = {
  capabilities: { can_stream: true, can_send: true, can_interrupt: true, can_approve: true },

  unavailable: (a) => (a.session_id ? null : `${a.name} has no Codex thread yet`),

  // The thread's turns flattened to messages, oldest first; `before` names the oldest message
  // the caller has, and the page is the `limit` messages before it.
  async page(a, { limit, before }) {
    const r = await appServer(a.id, 'thread/read', { threadId: a.session_id, includeTurns: true });
    const all: ViewMessage[] = [];
    const times = itemTimes(r.thread?.path);
    for (const t of r.thread?.turns ?? []) {
      // An item's own start where the rollout has it, else just after the one before it.
      let at = (t.startedAt ?? 0) * 1000;
      (t.items ?? []).forEach((it: any, i: number) => {
        at = Math.max(times.get(String(it.id)) ?? 0, at + (i ? 1 : 0));
        const m = fromItem(it, at, t.status === 'inProgress');
        if (m) all.push(m);
      });
    }
    const end = before ? Math.max(0, all.findIndex((m) => m.id === before)) : all.length;
    const start = Math.max(0, end - limit);
    return { messages: all.slice(start, end), older: start > 0 ? all[start].id : null };
  },

  async status(a) {
    const r = await appServer(a.id, 'thread/turns/list', { threadId: a.session_id, limit: 1 }).catch(() => undefined);
    const permissions = openRequests(a.id)
      .filter((q) => q.method in APPROVALS && ours(a, q.params?.threadId))
      .map((q) => permissionOf(q.id, q.method, q.params));
    return { running: r?.data?.[0]?.status === 'inProgress', permissions };
  },

  follow(a, live) {
    // Approvals sent to this view become permission parts; the rest of the requests stay the TUI's.
    return listen(a.id, {
      notify: (method, p) => onNote(a, live, method, p),
      request(id, method, p) {
        if (!(method in APPROVALS) || !ours(a, p.threadId)) return;
        const perm = permissionOf(id, method, p);
        live.store.ask(perm);
        live.changed();
      },
    });
  },

  // 'steer' joins the running turn (turn/steer); otherwise a turn/start, which the app-server
  // takes as the next turn.
  async prompt(a, text, delivery) {
    const fresh = db.getAgent(a.id) ?? a;
    if (delivery === 'steer') await steerPrompt(fresh, text);
    else await codex.pushPrompt(fresh, text);
  },

  interrupt: (a) => codex.interrupt!(db.getAgent(a.id) ?? a),

  async answerPermission(a, request, decision) {
    const q = openRequests(a.id).find((x) => String(x.id) === request && x.method in APPROVALS && ours(a, x.params?.threadId));
    if (!q) throw new ViewError(409, 'that approval is no longer waiting');
    const key = `${a.id}:${q.id}`;
    decided.set(key, decision);
    // Taken as it's sent: a second answer to the same request finds it gone.
    if (!answerRequest(a.id, q.id, { decision: DECISION[decision] })) {
      decided.delete(key);
      throw new ViewError(409, `${a.name}'s approval can't be answered now`);
    }
  },
};
