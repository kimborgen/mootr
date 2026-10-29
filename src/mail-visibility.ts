// Who may see a mail (S-359, S-388, S-448), for one mailbox: an agent or the human. The daemon's
// mail reads check it for the box they read as, and sendMail checks it for an agent's reply_to
// (S-466), so a reply goes only to a mail its sender may read, on this daemon or a peer.

import * as db from './db.ts';
import * as itsa from './itsa.ts';
import { sharedThreads } from './mail-search.ts';
import { ancestors, chiefOfStaff } from './org.ts';
import { REPORT_KIND } from './feedback.ts';
import { RETRO_KIND } from './retro.ts';
import { HUMAN } from './mail.ts';

// The assistant acts for the human: everything the human may do through stam, it may too.
export function isAssistant(id: unknown): boolean {
  // By id only: a name that happens to equal the assistant's id must not pass for it.
  return !!id && (db.open().prepare('SELECT kind FROM agents WHERE id = ?').get(String(id)) as { kind: string } | undefined)?.kind === 'assistant';
}

// The ITSA kinds every agent adds to (S-480): a retro item takes +1s, and a feedback report takes
// repeated reports, from agents that aren't in it. Read at call time: the modules import each other.
export function isOpenBoard(kind: string | null | undefined): boolean {
  return kind === RETRO_KIND || kind === REPORT_KIND;
}

// Whether an agent is one of those an ITSA belongs to (S-480): the ITSA's owner, a participant
// unless `participants` is false, the owner of an ancestor ITSA, the chief of staff, or the
// assistant. The creator counts as a participant for this, though it isn't one in the list (S-586):
// it keeps the rights it had when every creator joined, but gets no relays once it hands the ITSA on.
// The human is one too; the daemon lets the human through before asking. `me` is the agent's id: a
// name never matches, so an id that happens to equal another agent's name is refused.
function isMember(me: string, x: itsa.Itsa, participants = true): boolean {
  if (chiefOfStaff()?.id === me || isAssistant(me)) return true;
  if (x.owner === me || (participants && (x.created_by === me || itsa.participants(x.id).includes(me)))) return true;
  return itsa.ancestorsOf(x).some((p) => p.owner === me);
}

// Whether an agent may read an ITSA's mail threads (S-262, S-269, S-480): those it belongs to.
// Throws for an unknown ITSA.
export function mayReadItsaThreads(me: string, itsaId: string): boolean {
  return isMember(me, itsa.must(itsaId));
}

// Whether an agent may post to an ITSA's thread, which makes it a participant (S-480): those it
// belongs to, and on an open board anyone. Throws for an unknown ITSA.
export function mayPostItsa(me: string, itsaId: string): boolean {
  const x = itsa.must(itsaId);
  return isOpenBoard(x.kind) || isMember(me, x);
}

// Whether an agent may change an ITSA (S-480): those it belongs to, where posting to an open board
// doesn't count, as it would let anyone close a retro item after a +1. Throws for an unknown ITSA.
export function mayEditItsa(me: string, itsaId: string): boolean {
  const x = itsa.must(itsaId);
  return isMember(me, x, !isOpenBoard(x.kind));
}

// The fix named when an agent may not post to an ITSA (S-2424): ask its owner, or the agent that spawned
// the refused one, to add it with itsa_set participants. Names only who exists.
function joinAsk(me: string, x: itsa.Itsa, name: (id: string) => string): string {
  const owner = x.owner && x.owner !== HUMAN ? `the owner, ${name(x.owner)}` : null;
  const spawner = db.getAgent(me)?.parent_id;
  const asked = [owner, spawner ? `the agent that spawned you (${name(spawner)})` : null].filter(Boolean);
  return `Ask ${asked.length ? asked.join(', or ') : 'one of them'} to add you with itsa_set participants.`;
}

// Why an agent may not read, post to, or change an ITSA: who may, by name, and how to join. A participant
// of an open board (a feedback report or retro item) may post to it but not change it (S-480), so for a
// change those participants aren't named as may.
export function itsaRefusal(me: string, itsaId: string, verb: string): string {
  const x = itsa.must(itsaId);
  const name = (id: string) => db.getAgent(id)?.name ?? id;
  const owners = [x.owner, ...itsa.ancestorsOf(x).map((p) => p.owner)].filter((o): o is string => !!o);
  const boardOnly = verb === 'change' && isOpenBoard(x.kind);
  const who = [...new Set([...owners, ...(boardOnly ? [] : itsa.participants(x.id))])].filter((p) => p !== HUMAN).map(name);
  const may = boardOnly ? 'only its owner, the owners of its parent ITSAs, the chief of staff, the assistant, and the human may change it' : 'only its owner and participants, the owners of its parent ITSAs, the chief of staff, the assistant, and the human may';
  const how = boardOnly ? 'Ask one of them to make the change.' : verb === 'post to' ? joinAsk(me, x, name) : 'Ask one of them to add you as a participant.';
  return `${name(me)} can't ${verb} ${x.key}: ${may}${who.length ? ` (${who.join(', ')})` : ''}. ${how}`;
}

// An ask placed in its home thread (S-3827, ask-home.ts), its link line in the ITSA thread, a reply to one between the
// human and the asker (ASK_REPLY), or stam's note on it to the human (ASK_NOTE: it expired, its input didn't match): a
// mail that joined a thread it didn't start. Its home was picked for the human; the thread's other readers didn't see
// the ask before, and its replies and notes speak of the ask.
export function isPlacedAsk(x: { id: string; thread_id?: string | null; permission_id?: string | null; kind?: string | null }): boolean {
  return (!!x.permission_id || x.kind === ASK_LINK || x.kind === ASK_REPLY || x.kind === ASK_NOTE) && !!x.thread_id && x.thread_id !== x.id;
}
export const ASK_LINK = 'ask-link';
export const ASK_REPLY = 'ask-reply';
export const ASK_NOTE = 'ask-note';

// Whether a mailbox sees a placed ask: exactly those who saw it when every ask started a thread of its own, by the
// mail's holders (its sender and recipients): a holder, one above a holder (a parent acts for its children), one
// below a holder (who read the thread with the human its parent took part in, sharedThreads), or one that took over a
// holder's work. Never by the thread: reading the home thread whole doesn't show it. The caller lets the chief of
// staff and the assistant see any mail.
export function seesPlacedAsk(box: string, holders: string[]): boolean {
  const me = db.getAgent(box);
  const above = me ? ancestors(me) : new Set<string>();
  return holders.some((h) => {
    if (h === box || above.has(h)) return true;
    const a = db.getAgent(h);
    return !!a && (ancestors(a).has(box) || db.forwardTarget(h) === box);
  });
}

const holdersOf = (y: db.ThreadMail) => [y.from_id, ...y.recipients.map((r) => r.id)];

// The mail of one thread a mailbox reads whole, without the placed asks it doesn't see (S-3827).
export function withoutHiddenAsks<T extends db.ThreadMail>(box: string, mails: T[]): T[] {
  if (box === HUMAN) return mails;
  return mails.filter((y) => !isPlacedAsk(y) || seesPlacedAsk(box, holdersOf(y)));
}

// A thread as a mailbox's list shows it (GET /api/agents/:box/threads): without the placed asks it doesn't see, and,
// when the box is in the thread only by its own placed ask, only the mail it may read (S-3827): the ask makes it part
// of the thread for the list, never a reader of the thread's other mail.
export function listedThread<T extends { thread_id: string; mails: db.ThreadMail[] }>(box: string, t: T): T {
  if (box === HUMAN) return t;
  const mails = withoutHiddenAsks(box, t.mails);
  if (mails.some((y) => !isPlacedAsk(y) && holdersOf(y).includes(box))) return { ...t, mails };
  const r = threadReader(box, t.thread_id);
  return { ...t, mails: r === true ? mails : mails.filter(r) };
}

// Whether a mailbox may read a whole thread, not only its own part: a thread with the human that one
// of its ancestors took part in (mail-search.ts), or the own thread of an ITSA whose threads it may read
// (S-448). An ITSA's thread is read whole only by those it belongs to, as `reader`, the agent asking,
// which may be reading a box it acts for (a child's): no inherited access to it (S-480).
export function mayReadWholeThread(box: string, threadId: string, reader = box): boolean {
  // A grant is the agent's own: not read through a box it acts for, as ITSA threads aren't (S-480).
  if (reader === box && db.threadGranted(threadId, box)) return true;
  const itsas = db.threadItsaIds(threadId);
  if (itsas.length) return itsas.some((id) => { try { return mayReadItsaThreads(reader, id); } catch { return false; } });
  return sharedThreads(box).includes(threadId);
}

// Whether a mailbox sees a mail: if the box, or an agent under it (as a parent may act for its
// children), sent or received it, or took over the work of one that did (cost_switch's successor);
// if `reader`, the agent asking, may read the mail's ITSA threads; or if it may read the mail's
// whole thread. The caller lets the chief of staff and the assistant see any mail, by the box as it names it.
export function mayReadMail(box: string, x: db.Mail, reader = box): boolean {
  const held = db.threadMail(x.thread_id ?? x.id).find((y) => y.id === x.id);
  const holders = held ? [held.from_id, ...held.recipients.map((r) => r.id)] : [];
  if (isPlacedAsk(x)) return box === HUMAN || seesPlacedAsk(box, holders);
  const under = (h: string) => !!db.getAgent(h) && ancestors(db.getAgent(h)!).has(box);
  if (holders.some((h) => h === box || under(h) || (!!db.getAgent(h) && db.forwardTarget(h) === box))) return true;
  if (x.itsa_id) {
    try {
      if (mayReadItsaThreads(reader, x.itsa_id)) return true;
    } catch {}
  }
  return mayReadWholeThread(box, x.thread_id ?? x.id, reader);
}

// What a mailbox may read in one thread, decided with one load of the thread: `true` when it may read the whole thread,
// else a test for a mail of it, by the same rules as mayReadMail. For many mails of one thread.
export function threadReader(box: string, threadId: string, reader = box): true | ((x: db.Mail) => boolean) {
  const mails = db.threadMail(threadId);
  const holders = new Map(mails.map((y) => [y.id, holdersOf(y)]));
  // A thread with a placed ask isn't read whole by all of its readers: the ask goes by its holders (S-3827).
  const placed = (x: db.Mail) => isPlacedAsk(x) && box !== HUMAN;
  const seesAsk = (x: db.Mail) => seesPlacedAsk(box, holders.get(x.id) ?? []);
  if (mayReadWholeThread(box, threadId, reader)) return mails.some(placed) ? (x) => !placed(x) || seesAsk(x) : true;
  const sees = new Map<string, boolean>();
  const seesHolder = (h: string) => {
    if (!sees.has(h)) sees.set(h, h === box || (!!db.getAgent(h) && (ancestors(db.getAgent(h)!).has(box) || db.forwardTarget(h) === box)));
    return sees.get(h)!;
  };
  return (x) => {
    if (placed(x)) return seesAsk(x);
    if ((holders.get(x.id) ?? []).some(seesHolder)) return true;
    if (!x.itsa_id) return false;
    try {
      return mayReadItsaThreads(reader, x.itsa_id);
    } catch {
      return false;
    }
  };
}

// Opens to a new agent the threads its brief cites by mail id (S-1107): each mail the spawner may
// read whole, here, becomes readable whole to the agent, which also lets it reply in the thread. An
// id the spawner can't read opens nothing; no spawner (the human) reads any. Returns the thread ids.
export function grantCitedThreads(text: string, spawner: string | undefined, agentId: string): string[] {
  const granted = new Set<string>();
  for (const id of new Set(text.match(/\bm[0-9a-f]{7}\b/g) ?? [])) {
    const x = db.getMail(id);
    if (!x) continue;
    const tid = x.thread_id ?? x.id;
    // The whole thread opens, so the spawner must read every mail of it, not only the cited one.
    if (spawner && !(chiefOfStaff()?.id === spawner || isAssistant(spawner) || readsAll(spawner, tid))) continue;
    db.grantThread(tid, agentId);
    granted.add(tid);
  }
  return [...granted];
}

function readsAll(box: string, threadId: string): boolean {
  const r = threadReader(box, threadId);
  // A placed ask the box doesn't see stays sealed in a granted thread too (S-3827), so it doesn't hold the grant back.
  return r === true || db.threadMail(threadId).every((y) => isPlacedAsk(y) || r(y));
}
