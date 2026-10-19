// Declared waits and timers, and the one scheduler that fires them.
//
// An agent declares a wait for a reply itself (`wait_for`): it clears when the awaited mail
// arrives (mail.ts calls clearDeclaredWaits), or on a timeout, which tells the agent. An
// agent schedules a wake-up with `wake_me`: a one-off note, or a cron or periodic timer that
// fires its note each time and stays until `wait_done`. Both are rows of the `waits` table
// (db.ts); this module owns their shape and the scheduler that drives `until`.
import * as db from './db.ts';
import { queueNotice, tellAnywhere } from './mail.ts';
import { locateAgent, peerByName } from './peers.ts';
import { render } from './templates.ts';
import { sanitizeFilter, type EventFilter } from './watch.ts';

const minutesFromNow = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

// --- Declaring a wait ----------------------------------------------------------------

// A reply wait (`on` 'agent' or 'human') clears when the awaited mail arrives; see
// clearDeclaredWaits in mail.ts. An event wait (`on` 'event') clears on the first external
// event its filter fits; see watch.ts, clearEventWaits. `on` becomes the wait's kind, so the
// existing rank and summary cover it. A timeout clears any of them, as the scheduler fires it.
export async function declare(agentId: string, body: any): Promise<db.Wait> {
  const a = db.getAgent(agentId)!;
  const on = String(body?.on ?? '');
  if (on !== 'agent' && on !== 'human' && on !== 'event') throw new Error("on must be 'agent', 'human', or 'event'");
  const timeout = body?.timeout_minutes == null ? null : Number(body.timeout_minutes);
  if (timeout != null && !(timeout > 0)) throw new Error('timeout_minutes must be positive');
  const note = String(body?.note ?? '').trim();
  const until = timeout == null ? null : minutesFromNow(timeout);

  if (on === 'event') {
    const filter = sanitizeFilter(body?.filter);
    const detail = note || `an external event (${describeFilter(filter)})`;
    const data: Record<string, unknown> = { on, filter };
    if (timeout != null) data.timeout_minutes = timeout;
    const w = db.addWait({ agent_id: agentId, kind: 'event', source: 'declared', detail, until, data: JSON.stringify(data) });
    db.addEvent(agentId, 'wait:declared', { id: w.id, kind: 'event', filter, timeout_minutes: timeout });
    return w;
  }

  let target: string | null = null;
  let targetName = "your user";
  if (on === 'agent') {
    // The target may run on another machine; ids are unique across machines.
    const ref = body?.target ? String(body.target) : '';
    if (!ref) throw new Error("wait_for on 'agent' needs target (an agent id or name)");
    const t = db.getAgent(ref) ?? (await peerTarget(ref));
    if (!t) throw new Error(`no agent ${ref}`);
    // An archived agent never sends the reply, so the wait would never clear.
    if (t.lifecycle === 'archived') throw new Error(`no agent ${ref} (archived)`);
    target = t.id;
    targetName = t.name;
  }
  const thread = body?.thread == null || body.thread === '' ? null : String(body.thread);
  // A wait on the human from an agent whose request is pending with them is about that request
  // (S-609): tied to it, it shows as the request's one row and clears when the request settles.
  // A note naming only a settled request, with no thread to wait in, waits on nothing.
  if (on === 'human') {
    const settled = thread ? undefined : settledNamed(agentId, note);
    if (settled) throw new Error(`request ${settled.id} is already ${settled.status}, so your user has nothing left to answer for it. To wait for their reply to a mail, pass that mail's thread`);
    target = requestWaitedOn(agentId, note, thread)?.id ?? null;
  }
  const detail = note || (on === 'human' ? "your user's reply" : `reply from ${targetName}`);
  const data: Record<string, unknown> = { on };
  if (target) data.target = target;
  if (thread) data.thread = thread;
  if (timeout != null) data.timeout_minutes = timeout;
  const w = db.addWait({ agent_id: agentId, kind: on, source: 'declared', target, detail, until, data: JSON.stringify(data) });
  // The agent awaited gets one notice naming the thread to answer in.
  if (on === 'agent' && target) {
    const text = render('wait-for', { name: a.name, thread: thread ? ` (thread ${thread})` : '' });
    tellAnywhere(target, text).catch((e) => console.error(`wait_for notice for ${targetName}: ${e instanceof Error ? e.message : e}`));
  }
  db.addEvent(agentId, 'wait:declared', { id: w.id, kind: on, target, thread, timeout_minutes: timeout });
  return w;
}

const REQUEST_ID = /\bp[0-9a-f]{6}\b/g;
const named = (note: string) => new Set(note.match(REQUEST_ID) ?? []);

// The request a wait on the human is about (S-609): one of the agent's requests to the human that
// was pending when the wait began (`since`; now for a new wait). The one its note names, else the
// one whose thread it waits in, else, waiting in no thread, the newest. A wait in another thread
// waits for a reply to that thread's mail.
export function requestWaitedOn(agentId: string, note: string, thread: string | null, since?: string): db.RequestState | undefined {
  const open = db.agentRequests(agentId).filter((r) => r.audience === 'human' && (since === undefined
    ? r.status === 'pending'
    : r.created_at <= since && (r.status === 'pending' || (!!r.decided_at && r.decided_at >= since))));
  const ids = named(note);
  const byName = open.find((r) => ids.has(r.id));
  if (byName) return byName;
  if (thread) {
    const id = db.requestOfThread(db.getMail(thread)?.thread_id ?? thread);
    return open.find((r) => r.id === id);
  }
  return open[0];
}

// A settled request of the agent's that a new wait's note names, when it names none still pending.
export function settledNamed(agentId: string, note: string): db.RequestState | undefined {
  const ids = named(note);
  if (!ids.size) return undefined;
  const mine = db.agentRequests(agentId).filter((r) => ids.has(r.id));
  return mine.some((r) => r.status === 'pending') ? undefined : mine[0];
}

// An agent on a peer: found there now, or, when that peer doesn't answer, one this daemon has
// met before (send_mail queues to such an agent the same way, S-235). Its mail reaches us
// through the peer link, so the wait clears on it. The caller refuses an archived one.
async function peerTarget(ref: string): Promise<{ id: string; name: string; lifecycle?: string } | undefined> {
  const f = await locateAgent(ref);
  if (typeof f === 'object') return f.agent;
  if (f !== 'unreachable') return undefined;
  const known = db.findPeerAgent(ref);
  if (!known || !peerByName(known.machine)) return undefined;
  return { ...known, lifecycle: db.peerAgentLifecycle(known.id) };
}

// A filter as one readable phrase, for an event wait without a note.
function describeFilter(f: EventFilter): string {
  const bits: string[] = [];
  if (f.source) bits.push(`source ${f.source}`);
  if (f.subjects?.length) bits.push(`subjects ${f.subjects.join(', ')}`);
  if (f.types?.length) bits.push(`types ${f.types.join(', ')}`);
  if (f.actors?.length) bits.push(`actors ${f.actors.join(', ')}`);
  if (f.exclude_actors?.length) bits.push(`not by ${f.exclude_actors.join(', ')}`);
  return bits.length ? bits.join('; ') : 'any';
}

// The agent's waits as the web reads them: each with `thread`, the mail thread its wait is tied
// to (data.thread, a mail id resolved to its thread as clearDeclaredWaits does), or null.
// The open waits on the human, from every agent this daemon holds (S-637): the thread each names, if
// any, and the request or mail it is tied to. Auto-archive keeps those threads in the human's inbox.
export function openHumanWaits(): { thread: string | null; target: string | null; agent: string }[] {
  return (db.open().prepare("SELECT agent_id, target, data FROM waits WHERE kind = 'human'").all() as { agent_id: string; target: string | null; data: string | null }[]).map((w) => {
    const ref = parseData(w.data).thread;
    return { thread: ref ? (db.mailThreadId(String(ref)) ?? String(ref)) : null, target: w.target, agent: w.agent_id };
  });
}

export function webWaits(agentId: string): (db.Wait & { thread: string | null })[] {
  return db.listWaits(agentId).map((w) => {
    const ref = parseData(w.data).thread;
    if (!ref) return { ...w, thread: null };
    return { ...w, thread: db.mailThreadId(String(ref)) ?? String(ref) };
  });
}

// Every agent's web waits, as webWaits(agentId) gives them, in one pass (GET /api/agents): the thread of
// each wait's mail is read in one query for all of them.
export function webWaitsByAgent(): Map<string, (db.Wait & { thread: string | null })[]> {
  const byAgent = db.listWaitsByAgent();
  const refs = new Map<string, string>();
  for (const ws of byAgent.values()) for (const w of ws) {
    const ref = parseData(w.data).thread;
    if (ref) refs.set(w.id, String(ref));
  }
  const threads = db.mailThreadIds([...new Set(refs.values())]);
  return new Map([...byAgent].map(([id, ws]) => [id, ws.map((w) => {
    const ref = refs.get(w.id);
    return { ...w, thread: ref ? threads.get(ref) ?? ref : null };
  })]));
}

// --- Timers (wake_me)  --------------------------------------------------------------------

// Exactly one schedule. A one-off ('in_minutes' or 'at') clears when it fires; 'cron' and
// 'every_minutes' repeat, moving `until` to the next fire time, until `wait_done`. `data`
// keeps the schedule so a restart can recompute the next fire.
export function wake(agentId: string, body: any, tag?: string): db.Wait {
  const note = String(body?.note ?? '').trim();
  if (!note) throw new Error('wake_me needs a note');
  const modes = (['in_minutes', 'at', 'cron', 'every_minutes'] as const).filter((k) => body?.[k] != null && body[k] !== '');
  if (modes.length !== 1) throw new Error('wake_me needs exactly one of in_minutes, at, cron, every_minutes');
  const mode = modes[0];
  const now = new Date();
  const data: Record<string, unknown> = {};
  let until: string;
  if (mode === 'in_minutes') {
    const n = Number(body.in_minutes);
    if (!(n > 0)) throw new Error('in_minutes must be positive');
    data.in_minutes = n;
    until = minutesFromNow(n);
  } else if (mode === 'at') {
    const t = new Date(String(body.at));
    if (Number.isNaN(t.getTime())) throw new Error(`at must be an ISO time, got "${body.at}"`);
    data.at = t.toISOString();
    until = t.toISOString();
  } else if (mode === 'cron') {
    const spec = String(body.cron).trim();
    const next = nextCron(spec, now);
    data.cron = spec;
    until = next.toISOString();
  } else {
    const n = Number(body.every_minutes);
    if (!(n > 0)) throw new Error('every_minutes must be positive');
    data.every_minutes = n;
    until = minutesFromNow(n);
  }
  // A daemon-owned schedule (tree-check.ts) tags its timer so it can find and replace it.
  // `tag` is an argument, never read from `body`, so an agent can't claim another schedule's tag.
  if (tag) data.tag = tag;
  const w = db.addWait({ agent_id: agentId, kind: 'timer', source: 'stam', detail: note, until, data: JSON.stringify(data) });
  db.addEvent(agentId, 'wait:wake', { id: w.id, mode, until, note: note.slice(0, 120) });
  return w;
}

// Clears one of the agent's own declared or timer waits. Hook waits are the harness's.
export function done(agentId: string, id: unknown): boolean {
  const w = id ? db.getWait(String(id)) : undefined;
  if (!w || w.agent_id !== agentId || (w.source !== 'declared' && w.source !== 'stam')) return false;
  return db.clearWait(w.id);
}

// --- The scheduler -----------------------------------------------------------------------

// Fires every wait whose `until` has passed. A declared wait times out. A timer sends its
// note as a notice and either clears (one-off) or moves `until` to its next fire time.
// Called once at daemon start, so timers that came due while it was down fire once (the
// next fire is computed from now, never per missed tick), then on every tick.
export async function tick(now = new Date()): Promise<number> {
  let fired = 0;
  for (const w of db.dueWaits(now.toISOString())) {
    const data = parseData(w.data);
    if (w.source === 'declared') {
      const minutes = data.timeout_minutes ?? Math.round((Date.parse(w.until!) - Date.parse(w.since)) / 60_000);
      db.clearWait(w.id);
      queueNotice(w.agent_id, render('wait-timeout', { what: w.detail ?? `${w.kind} reply`, minutes }));
      db.addEvent(w.agent_id, 'wait:timeout', { id: w.id, kind: w.kind, target: w.target });
    } else {
      queueNotice(w.agent_id, w.detail ?? 'timer');
      const next = nextFire(data, now);
      if (next) db.setWaitUntil(w.id, next);
      else db.clearWait(w.id);
      db.addEvent(w.agent_id, 'wait:woke', { id: w.id, until: next ?? null });
    }
    fired++;
  }
  return fired;
}

function parseData(raw: string | null): any {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// The next fire time of a repeating timer, from now; null for a one-off.
function nextFire(data: any, now: Date): string | null {
  if (data.cron) return nextCron(String(data.cron), now).toISOString();
  if (typeof data.every_minutes === 'number' && data.every_minutes > 0) return minutesFromNow(data.every_minutes);
  return null;
}

let started = false;

// One scheduler per daemon. The first tick runs at once, catching up on a restart.
export function startScheduler(intervalMs = 1000): void {
  if (started) return;
  started = true;
  const run = () => tick().catch((e) => console.error(`waits: ${e instanceof Error ? e.message : e}`));
  run();
  setInterval(run, intervalMs);
}

// --- A small 5-field cron parser ---------------------------------------------------------
// minute hour day-of-month month day-of-week. A field is a comma list of numbers, '*',
// ranges 'a-b', and steps ('*/n' or 'a-b/n'). Day-of-month and day-of-week are OR'd when
// both are restricted, as cron does. Times are this machine's local time.

export function nextCron(spec: string, from: Date): Date {
  const fields = spec.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron needs 5 fields, got ${fields.length}: "${spec}"`);
  const [mi, ho, dom, mo, dow] = fields;
  const minutes = fieldValues(mi, 0, 59, 'minute');
  const hours = fieldValues(ho, 0, 23, 'hour');
  const doms = fieldValues(dom, 1, 31, 'day of month');
  const months = fieldValues(mo, 1, 12, 'month');
  const dows = fieldValues(dow, 0, 7, 'day of week');
  if (dows.includes(7)) {
    dows.splice(dows.indexOf(7), 1);
    dows.push(0);
    dows.sort((a, b) => a - b);
  }
  const domStar = dom.startsWith('*');
  const dowStar = dow.startsWith('*');
  const dayMatches = (d: Date) => {
    const dm = doms.includes(d.getDate());
    const dw = dows.includes(d.getDay());
    return !domStar && !dowStar ? dm || dw : dm && dw;
  };
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let i = 0; i < 366 * 5; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (!months.includes(d.getMonth() + 1) || !dayMatches(d)) continue;
    for (const h of hours) for (const m of minutes) {
      const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
      if (cand.getTime() <= from.getTime()) continue;
      // A local time inside a daylight-saving gap doesn't exist: the Date moves it an hour
      // later. Only a candidate whose fields still match is a real fire time; skip the rest.
      if (cand.getHours() !== h || cand.getMinutes() !== m || cand.getDate() !== d.getDate() || cand.getMonth() !== d.getMonth()) continue;
      return cand;
    }
  }
  throw new Error(`no cron time within 5 years for "${spec}"`);
}

// The field's values, validated and sorted.
function fieldValues(spec: string, min: number, max: number, name: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron ${name} step in "${part}"`);
    let lo = min;
    let hi = max;
    if (range !== '' && range !== '*') {
      const m = range.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) throw new Error(`bad cron ${name} "${part}"`);
      lo = Number(m[1]);
      hi = m[2] === undefined ? lo : Number(m[2]);
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron ${name} out of range in "${part}" (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (!out.size) throw new Error(`empty cron ${name} "${spec}"`);
  return [...out].sort((a, b) => a - b);
}