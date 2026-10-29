// The Needs you list (S-3831): every open ask of every kind on this daemon, plus each one settled
// in the last day with its outcome. It is read from durable rows (permission requests, ITSA status
// events, comms events), so a restart keeps the history. The daemon merges its peers' rows in, so
// an ask settled on another machine shows settled here too. A row carries no secret: only the one
// line the ask card already shows (the action, the ITSA's title, the mail's subject).
import * as db from './db.ts';
import * as itsa from './itsa.ts';
import * as itsaHuman from './itsa-human.ts';
import * as decisionMail from './decision-mail.ts';

export type AskKind = 'request' | 'dialog' | 'settings' | 'input' | 'itsa' | 'decision';

export interface Ask {
  // Unique across machines: the kind and the row's own id.
  key: string;
  kind: AskKind;
  // open: waits on the human now. settled: answered, withdrawn or expired in the last day.
  state: 'open' | 'settled';
  // Settled only: approved, denied, typed, failed, expired, withdrawn, answered or superseded.
  outcome: string | null;
  // One line: the action asked, the ITSA's title, or the decision mail's subject.
  what: string;
  agent_id: string | null;
  agent_name: string | null;
  machine: string;
  // The thread or ITSA the ask lives in: the row opens there, where the ask card answers it.
  thread_id: string | null;
  itsa_id: string | null;
  // When it was asked.
  since: string;
  // When it settled; null while open.
  settled_at: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ONE_LINE = 160;

// One line of text, cut short: the what of a row, for text that carries no secret (an ITSA's title, a mail's subject).
function oneLine(s: string | null | undefined): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > ONE_LINE ? `${t.slice(0, ONE_LINE - 1)}…` : t;
}

// A permission request's what: its kind, never its text. The action and details can hold a command
// with a credential in it, and no helper redacts arbitrary text, so the ask card (one click away) shows them.
const PERMISSION_WHAT: Record<AskKind, string> = {
  request: 'Permission request',
  dialog: 'Harness dialog',
  settings: 'Settings change',
  input: 'Suggested input',
  itsa: '',
  decision: '',
};

function agentName(id: string | null): string | null {
  if (!id) return null;
  return db.getAgent(id)?.name ?? null;
}

// A permission request (request_permission, a harness dialog, a settings change, a suggested input):
// open while pending or held, settled for a day after it was decided. `since` is the start of that
// settled window; null reads the open ones only (openAsks).
function permissionAsks(machine: string, since: string | null): Ask[] {
  // Only the human's asks: a delegate's ask (a parent or the chief of staff decides it) is the human's once escalated.
  const rows = db.open().prepare(`SELECT p.id, p.kind, p.status, p.agent_id, p.home_thread, p.home_itsa, p.created_at, p.decided_at
    FROM permission_requests p
    WHERE p.audience = 'human' AND (p.status IN ('pending', 'held')${since ? " OR COALESCE(p.decided_at, p.created_at) >= ?" : ''})`).all(...(since ? [since] : [])) as unknown as {
    id: string; kind: AskKind; status: string; agent_id: string; home_thread: string | null; home_itsa: string | null; created_at: string; decided_at: string | null;
  }[];
  return rows.map((r) => {
    const open = r.status === 'pending' || r.status === 'held';
    // A suggested input that was approved was typed into the box.
    const outcome = open ? null : r.kind === 'input' && r.status === 'approved' ? 'typed' : r.status;
    return {
      key: `${r.kind}:${r.id}`,
      kind: r.kind,
      state: open ? 'open' : 'settled',
      outcome,
      what: PERMISSION_WHAT[r.kind],
      agent_id: r.agent_id,
      agent_name: agentName(r.agent_id),
      machine,
      thread_id: r.home_thread,
      itsa_id: r.home_itsa,
      since: r.created_at,
      settled_at: open ? null : r.decided_at ?? r.created_at,
    };
  });
}

// The ITSAs in a human status: open rows, the ask card's thread and ITSA. Settled rows are the
// status moves out of a human status in the last day: an approve is `approved`, any other action
// `answered`, and a move with no action (someone else changed it) `withdrawn`.
function itsaAsks(machine: string, since: string | null): Ask[] {
  const open = itsaHuman.attention().map((x): Ask => ({
    key: `itsa:${x.id}`,
    kind: 'itsa',
    state: 'open',
    outcome: null,
    what: oneLine(x.title),
    agent_id: x.owner ?? null,
    agent_name: agentName(x.owner ?? null),
    machine,
    thread_id: x.ask_thread_id,
    itsa_id: x.id,
    since: x.since,
    settled_at: null,
  }));
  if (!since) return open;
  const human = new Set(itsa.statuses().filter((s) => s.human).map((s) => s.name));
  const moves = db.open().prepare(`SELECT e.id, e.ts, e.data, e.itsa_id, i.title, i.owner
    FROM itsa_events e JOIN itsas i ON i.id = e.itsa_id
    WHERE e.type = 'status' AND e.ts >= ? ORDER BY e.id`).all(since) as unknown as { id: number; ts: string; data: string | null; itsa_id: string; title: string; owner: string | null }[];
  const next = db.open().prepare("SELECT type, data FROM itsa_events WHERE itsa_id = ? AND id > ? AND type IN ('action', 'status') ORDER BY id LIMIT 1");
  const settled: Ask[] = [];
  for (const e of moves) {
    const d = e.data ? (JSON.parse(e.data) as { from?: string; to?: string }) : {};
    if (!d.from || !human.has(d.from)) continue;
    // An action is written right after the status change it caused, from the same status. Any other
    // next event (a later status change) means this move had no action: it was withdrawn.
    const n = next.get(e.itsa_id, e.id) as { type: string; data: string | null } | undefined;
    const act = n?.type === 'action' && n.data ? (JSON.parse(n.data) as { id?: string; from?: string }) : null;
    const outcome = act && act.from === d.from ? (act.id === 'approve' ? 'approved' : 'answered') : 'withdrawn';
    settled.push({
      // The move out of the human status is the ask's cycle. An ITSA has one home and its events don't move, so the
      // ITSA and the move's own event id identify it (a time can repeat within a millisecond).
      key: `itsa:${e.itsa_id}#${e.id}`,
      kind: 'itsa',
      state: 'settled',
      outcome,
      what: oneLine(e.title),
      agent_id: e.owner ?? null,
      agent_name: agentName(e.owner ?? null),
      machine,
      thread_id: null,
      itsa_id: e.itsa_id,
      since: e.ts,
      settled_at: e.ts,
    });
  }
  return [...open, ...settled];
}

// The decision mails that wait on the human (open), and the ones answered or superseded in the last
// day (settled). A decision mail about an ITSA in a human status is the ITSA's row, so `held` (the
// ids of those ITSAs, on every home) leaves it out here.
function decisionAsks(machine: string, since: string | null, held: Set<string>): Ask[] {
  const open = decisionMail.withoutHeld(decisionMail.localDecisionMails(), held).map((m): Ask => ({
    key: `decision:${m.mail_id}`,
    kind: 'decision',
    state: 'open',
    outcome: null,
    what: oneLine(m.subject),
    agent_id: m.from_id,
    agent_name: m.from_name ?? agentName(m.from_id),
    machine,
    thread_id: m.thread_id,
    itsa_id: m.about_itsa,
    since: m.created_at,
    settled_at: null,
  }));
  if (!since) return open;
  const settled = (db.open().prepare(`SELECT c.id, c.ref, c.outcome, c.label, c.created_at, m.subject, m.from_id, m.from_name, m.thread_id, m.about_itsa, m.created_at AS asked_at
    FROM comms_events c LEFT JOIN mail m ON m.id = c.ref
    WHERE c.kind = 'decision' AND c.outcome IN ('answered', 'superseded', 'withdrawn') AND c.created_at >= ? ORDER BY c.id`).all(since) as unknown as {
    id: number; ref: string; outcome: string; label: string | null; created_at: string; subject: string | null; from_id: string | null; from_name: string | null; thread_id: string | null; about_itsa: string | null; asked_at: string | null;
  }[]).map((r): Ask => ({
    // The mail's id is the same on every daemon that holds the decision, so a copy settles once in the merged list.
    key: `decision:${r.ref}`,
    kind: 'decision',
    state: 'settled',
    outcome: r.outcome === 'answered' && r.label ? `answered: ${oneLine(r.label)}` : r.outcome,
    what: oneLine(r.subject),
    agent_id: r.from_id,
    agent_name: r.from_name ?? agentName(r.from_id),
    machine,
    thread_id: r.thread_id,
    itsa_id: r.about_itsa,
    since: r.asked_at ?? r.created_at,
    settled_at: r.created_at,
  }));
  return [...open, ...settled];
}

// The merged list, with a decision mail about an ITSA in a human status left out: that ITSA's row covers it.
// `held` is the ids of those ITSAs on every home. Settled decisions stay (they are history).
export function withoutHeldDecisions(all: Ask[], held: Set<string>): Ask[] {
  return all.filter((a) => !(a.kind === 'decision' && a.state === 'open' && a.itsa_id && held.has(a.itsa_id)));
}

// The order of the list: the open asks oldest first, then the ones settled in the last day, newest first.
export function ordered(all: Ask[]): Ask[] {
  const open = all.filter((a) => a.state === 'open').sort((a, b) => a.since.localeCompare(b.since));
  const settled = all.filter((a) => a.state === 'settled').sort((a, b) => (b.settled_at ?? '').localeCompare(a.settled_at ?? ''));
  return [...open, ...settled];
}

// Every ask this daemon holds, in the list's order. `held` is the ids of the ITSAs in a human status
// on every home (a decision mail about one of them is that ITSA's row).
export function localAsks(machine: string, held: Set<string>, now = new Date()): Ask[] {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  return ordered([...permissionAsks(machine, since), ...itsaAsks(machine, since), ...decisionAsks(machine, since, held)]);
}

// The open asks this daemon holds, in the list's order, with no settled rows read (the agent rows and ITSA views ask for
// these on every read).
export function openAsks(machine: string, held: Set<string>): Ask[] {
  return ordered([...permissionAsks(machine, null), ...itsaAsks(machine, null), ...decisionAsks(machine, null, held)]);
}

// The open ask each agent and each ITSA waits on, by the ask's key (S-3977). An agent's is its oldest open ask of its own
// (a permission of any kind, or a decision mail), else the ITSA ask a wait on the human is tied to. An ITSA's is its own open ask. Derived from the same rows as the list, so an ask that settles
// drops out of both at once, and a restart keeps the links. The rows, not just their keys: the web keys its link by `key`,
// and the agent text reads the mail and kind through askDetail (S-3982).
export function openAskLinks(machine: string, held: Set<string>): { agents: Map<string, Ask>; itsas: Map<string, Ask> } {
  const agents = new Map<string, Ask>();
  const itsas = new Map<string, Ask>();
  for (const a of openAsks(machine, held)) {
    if (a.kind === 'itsa') {
      if (a.itsa_id) itsas.set(a.itsa_id, a);
    } else if (a.agent_id && !agents.has(a.agent_id)) agents.set(a.agent_id, a);
  }
  const waits = db.open().prepare("SELECT DISTINCT agent_id, target FROM waits WHERE kind = 'human' AND target IS NOT NULL").all() as unknown as { agent_id: string; target: string }[];
  for (const w of waits) if (!agents.has(w.agent_id) && itsas.has(w.target)) agents.set(w.agent_id, itsas.get(w.target)!);
  return { agents, itsas };
}

// The kind labels of the Needs you list (web/src/mail/needsYou.ts KIND_LABEL), the action an open ask is in a few words.
const KIND_LABEL: Record<AskKind, string> = {
  request: 'Permission',
  dialog: 'Harness dialog',
  settings: 'Settings change',
  input: 'Suggested input',
  itsa: 'ITSA',
  decision: 'Decision',
};

// What the text an agent reads says of its open ask (find_agents, itsa_get): the mail to open it in, and its kind. Never the
// ask's text, which the card holds. Null when there is no open ask.
export interface AskDetail { mail: string | null; kind: string }
export function askDetail(a: Ask | undefined): AskDetail | null {
  return a ? { mail: a.thread_id, kind: KIND_LABEL[a.kind] } : null;
}
