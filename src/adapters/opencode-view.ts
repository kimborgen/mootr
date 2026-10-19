// OpenCode's part of stam's own agent view (src/agent-view.ts): stored messages from
// stam's private OpenCode server (GET /api/session/:id/message), live deltas from its
// event stream, and prompts, interrupts, and permission replies through its API. Every
// one of them shows in the agent's TUI too. Shapes as OpenCode v2.0.26 sends them
// (test/fixtures/opencode-view.json).
import * as db from '../db.ts';
import { oc, opencode, eventListeners } from './opencode.ts';
import type { LiveSink, ViewMessage, ViewPart, ViewPermission, ViewSource, ToolStatus, PermissionDecision, ViewStore } from '../agent-view.ts';

const textOf = (content: any): string =>
  Array.isArray(content) ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('') : typeof content === 'string' ? content : '';
const errorOf = (e: any): string | undefined => (e ? String(e.message ?? e.type ?? e) : undefined);

function toolStatus(s: string | undefined): ToolStatus {
  return s === 'completed' ? 'done' : s === 'error' ? 'error' : s === 'running' ? 'running' : 'pending';
}

// One stored OpenCode message as a view message, or null for one the view leaves out.
export function fromOpenCode(m: any): ViewMessage | null {
  const at = m.time?.created ?? 0;
  const sys = (kind: string, text: string): ViewMessage => ({ id: m.id, role: 'system', kind, at, parts: [{ type: 'text', text }] });
  switch (m.type) {
    case 'user':
      return { id: m.id, role: 'user', at, parts: [{ type: 'text', text: String(m.text ?? '') }] };
    case 'synthetic': // stam's notices and mail, and OpenCode's own reminders
      return sys('notice', String(m.text ?? ''));
    case 'system':
      return sys('system', String(m.text ?? ''));
    case 'skill':
      return sys('skill', `Skill ${m.name ?? m.skill}`);
    case 'shell': // a command the human ran in the TUI with !
      return {
        id: m.id,
        role: 'user',
        kind: 'shell',
        at,
        parts: [{ type: 'tool', id: m.shellID ?? m.id, name: 'shell', input: { command: m.command }, output: m.output?.output, status: m.status === 'running' ? 'running' : m.status === 'exited' && m.exit === 0 ? 'done' : 'error' }],
      };
    case 'compaction':
      return sys('compaction', m.status === 'failed' ? `Compaction failed: ${errorOf(m.error)}` : m.status === 'running' ? 'Compacting' : 'Compacted');
    case 'idle': // the end of a turn; only one that didn't succeed is worth a line
      return m.outcome === 'succeeded' ? null : sys(m.outcome, m.outcome === 'interrupted' ? 'Interrupted' : 'Turn failed');
    case 'model-switched':
      return sys('model', `Model ${m.model?.providerID}/${m.model?.id}`);
    case 'agent-switched':
      return sys('agent', `Agent ${m.agent}`);
    case 'assistant': {
      // Each part's time where OpenCode stores one (else the part before's), so the web view
      // splits a step at the mail that came during it (S-278).
      const parts: ViewPart[] = [];
      const marks: number[] = [];
      for (const c of m.content ?? []) {
        if (c.type === 'text' || c.type === 'reasoning') parts.push({ type: c.type, text: String(c.text ?? '') });
        else if (c.type === 'tool') {
          const st = c.state ?? {};
          parts.push({ type: 'tool', id: c.id, name: c.name, input: st.input, output: textOf(st.content) || errorOf(st.error), status: toolStatus(st.status) });
        } else continue;
        marks.push(Math.max(c.time?.created ?? 0, marks.at(-1) ?? at));
      }
      const out: ViewMessage = { id: m.id, role: 'assistant', at, marks, parts };
      if (!m.time?.completed) out.running = true;
      if (m.error) out.error = errorOf(m.error);
      return out;
    }
  }
  return null;
}

export function permissionOf(p: any): ViewPermission {
  return { id: p.id, action: String(p.action ?? ''), resources: p.resources ?? [], message: p.source?.messageID, tool: p.source?.id };
}

// Applies one server event to the store. Returns 'resync' when the stored messages are
// worth re-reading (a turn or step ended, a prompt arrived), true when the store changed.
export function applyEvent(store: ViewStore, ev: { type: string; data?: any }): boolean | 'resync' {
  const d = ev.data ?? {};
  const mid = d.assistantMessageID;
  // A part made live takes its start from the daemon's clock until a re-read gives OpenCode's,
  // so the web view splits a running step at the mail that came during it too (S-278).
  const timed = <P extends ViewPart>(p: P): P => {
    const m = store.message(mid);
    m.marks ??= [];
    while (m.marks.length < m.parts.length) m.marks.push(Date.now());
    return p;
  };
  const stream = (kind: 'text' | 'reasoning') => timed(store.part(mid, `${kind}:${d.ordinal}`, () => ({ type: kind, text: '' })));
  const tool = () => timed(store.part<Extract<ViewPart, { type: 'tool' }>>(mid, `tool:${d.id}`, () => ({ type: 'tool', id: d.id, name: d.name ?? 'tool', status: 'pending' })));
  switch (ev.type) {
    case 'session.text.started':
    case 'session.reasoning.started':
      stream(ev.type.includes('text') ? 'text' : 'reasoning');
      return true;
    case 'session.text.delta':
    case 'session.reasoning.delta':
      stream(ev.type.includes('text') ? 'text' : 'reasoning').text += d.delta ?? '';
      return true;
    case 'session.text.ended':
    case 'session.reasoning.ended': {
      const p = stream(ev.type.includes('text') ? 'text' : 'reasoning');
      if (typeof d.text === 'string') p.text = d.text;
      return true;
    }
    case 'session.tool.input.started':
      tool();
      return true;
    case 'session.tool.called':
      Object.assign(tool(), { input: d.input, status: 'running' });
      return true;
    case 'session.tool.success':
      Object.assign(tool(), { output: textOf(d.content), status: 'done' });
      return true;
    case 'session.tool.failed':
      Object.assign(tool(), { output: errorOf(d.error) ?? 'failed', status: 'error' });
      return true;
    case 'session.step.ended':
      if (mid) store.message(mid).running = false;
      return 'resync';
    case 'permission.asked':
      store.ask(permissionOf(d));
      return true;
    case 'permission.replied':
      store.answered(d.requestID, d.reply as PermissionDecision);
      return true;
    case 'session.execution.started':
      store.setRunning(true);
      return true;
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted':
      store.setRunning(false);
      for (const m of store.messages) if (m.running) (m.running = false), store.dirty.add(m.id);
      return 'resync';
    case 'session.inbox.delivered':
    case 'session.compaction.started':
    case 'session.compaction.ended':
      return 'resync';
  }
  return false;
}

// Views open per session; the server's one event stream feeds them all.
const following = new Map<string, Set<LiveSink>>();
eventListeners.add((ev) => {
  const set = following.get(ev.data?.sessionID ?? ev.data?.sessionId ?? '');
  if (!set) return;
  for (const live of set) {
    const r = applyEvent(live.store, ev);
    if (r) live.changed();
    if (r === 'resync') live.resync();
  }
});

// OpenCode's message cursor is base64url JSON naming the message to continue from (seen
// on v2.0.26); 'next' in descending order means older than it.
const olderThan = (id: string) => Buffer.from(JSON.stringify({ id, order: 'desc', direction: 'next' })).toString('base64url');

export const opencodeView: ViewSource = {
  capabilities: { can_stream: true, can_send: true, can_interrupt: true, can_approve: true },

  unavailable: (a) => (a.session_id ? null : `${a.name} has no OpenCode session yet`),

  // One more than asked, to know whether older messages exist.
  async page(a, { limit, before }) {
    const q = before ? `cursor=${olderThan(before)}` : 'order=desc';
    const rows = await oc('GET', `/api/session/${a.session_id}/message?${q}&limit=${limit + 1}`);
    const list: any[] = Array.isArray(rows) ? rows : [];
    const more = list.length > limit;
    const messages = list
      .slice(0, limit)
      .map(fromOpenCode)
      .filter((m): m is ViewMessage => !!m)
      .reverse();
    return { messages, older: more ? (list[limit - 1]?.id ?? null) : null };
  },

  async status(a) {
    const [active, perms] = await Promise.all([oc('GET', '/api/session/active'), oc('GET', `/api/session/${a.session_id}/permission`)]);
    return { running: a.session_id! in (active ?? {}), permissions: (Array.isArray(perms) ? perms : []).map(permissionOf) };
  },

  follow(a, live) {
    const sid = a.session_id!;
    let set = following.get(sid);
    if (!set) following.set(sid, (set = new Set()));
    set.add(live);
    return () => {
      set!.delete(live);
      if (!set!.size) following.delete(sid);
    };
  },

  // 'queue' waits for the turn to end; 'steer' joins the running turn at its next step.
  async prompt(a, text, delivery) {
    await oc('POST', `/api/session/${a.session_id}/prompt`, { text, delivery });
  },

  interrupt: (a) => opencode.interrupt!(db.getAgent(a.id) ?? a),

  async answerPermission(a, request, decision) {
    await oc('POST', `/api/session/${a.session_id}/permission/${request}/reply`, { decision });
  },
};
