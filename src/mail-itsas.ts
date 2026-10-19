// Links a stored mail to the ITSAs it is about (S-986), without making mail: no recipient, notice or
// unread state. Three sources, in this order of precedence: what the sender named (`itsa`, or an ITSA
// comment's own), keys written in the subject or body outside code that name an ITSA here, and the
// ITSA whose thread the mail is in.

import * as db from './db.ts';
import * as itsa from './itsa.ts';
import { namedKeys } from './itsa-keys.ts';
import { threadReader } from './mail-visibility.ts';

export function linkMail(m: { id: string; thread_id: string; subject?: string | null; body?: string | null; itsa_id?: string | null; about_itsa?: string | null }): void {
  // A comment in an ITSA's own thread carries that ITSA as its `itsa_id`; there it is the thread's ITSA, not one the mail names.
  const own = new Set(db.threadItsas(m.thread_id));
  const links: { itsa_id: string; source: db.MailItsaSource }[] = [];
  for (const id of [m.about_itsa, m.itsa_id]) if (id && !own.has(id)) links.push({ itsa_id: id, source: 'itsa' });
  for (const k of namedKeys(`${m.subject ?? ''}\n${m.body ?? ''}`).slice(0, db.MAX_NAMED_KEYS)) {
    const id = db.itsaIdOfKey(k);
    if (id) links.push({ itsa_id: id, source: own.has(id) ? 'thread' : 'named' });
  }
  for (const id of own) links.push({ itsa_id: id, source: 'thread' });
  db.linkMailItsas(m.id, links);
}

// The threads linked to an ITSA that a viewer may read (S-986), newest first, at most `limit`. The ITSA's own thread
// is left out. A row shows what the viewer may read: the subject, sender, date and source of the newest linked mail
// they may read, and the count of those. Readability is decided once per candidate thread (`readerOf`, null for a
// viewer who reads everything): a thread the viewer reads whole keeps its row, else its linked mail (at most
// MAX_THREAD_MAILS) is filtered in memory, so a thread is loaded once, never per mail.
export function readableLinkedThreads(itsaId: string, ownThread: string | null, limit: number, readerOf: ((threadId: string) => true | ((m: db.Mail) => boolean)) | null): db.LinkedThread[] {
  const out: db.LinkedThread[] = [];
  for (const t of db.linkedThreads(itsaId, ownThread, limit * LINKED_SCAN)) {
    const may = readerOf ? readerOf(t.thread_id) : true;
    if (may === true) out.push(t);
    else {
      const readable = db.linkedThreadMails(itsaId, t.thread_id, MAX_THREAD_MAILS).filter(may);
      if (readable.length) out.push(row(itsaId, t, readable));
    }
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => b.last_at.localeCompare(a.last_at));
}

function row(itsaId: string, t: db.LinkedThread, readable: db.Mail[]): db.LinkedThread {
  const m = readable[0]!;
  const source = db.mailItsaLinks([m.id]).get(m.id)?.find((l) => l.id === itsaId)?.source ?? t.source;
  return { ...t, mail_id: m.id, subject: m.subject, from_id: m.from_id, from_name: m.from_name ?? null, last_at: m.created_at, mails: readable.length, source };
}

// Threads looked at per thread wanted: those the viewer may not read are skipped.
const LINKED_SCAN = 4;
// Linked mails of one thread looked at for the viewer's count.
const MAX_THREAD_MAILS = 50;

// This daemon's part of /api/mail/linked/ID: the ITSA by id or key, as `viewer` may read it. `all` viewers (no box, the boss,
// the chief of staff, the assistant) see every linked thread; otherwise `box` is the mailbox asking and `reader` the agent
// asking for it.
export function linkedThreadsFor(ref: string, limit: number, viewer: { all: boolean; box: string; reader: string }): db.LinkedThread[] {
  const x = itsa.find(ref);
  return readableLinkedThreads(x?.id ?? ref, x?.thread_id ?? null, limit, viewer.all ? null : (threadId) => threadReader(viewer.box, threadId, viewer.reader));
}

export class AttachRefused extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Attaches ITSAs and agents to an existing mail (S-1305), silently: no new mail, notice or unread state. `boss` is
// the chief of staff, the assistant or the boss; otherwise `by` must be a recipient of the mail. Refs that name nothing
// are refused whole, so nothing half-attaches.
export function attachToMail(mailId: string, by: string, refs: { itsas?: string[]; agents?: string[] }, boss: boolean): { itsas: string[]; agents: string[] } {
  const m = db.getMail(mailId);
  if (!m) throw new AttachRefused(404, `no mail ${mailId} here`);
  if (!boss && !db.mailRecipientIds(mailId).includes(by)) throw new AttachRefused(403, 'only a recipient of the mail, or the chief of staff, attaches to it');
  const itsaIds: string[] = [];
  for (const ref of refs.itsas ?? []) {
    const x = itsa.find(ref);
    if (!x) throw new AttachRefused(404, `no ITSA ${ref}`);
    itsaIds.push(x.id);
  }
  const agentIds: string[] = [];
  for (const ref of refs.agents ?? []) {
    const a = db.getAgent(ref) ?? db.findPeerAgent(ref);
    if (!a) throw new AttachRefused(404, `no agent ${ref}`);
    agentIds.push(a.id);
  }
  if (!itsaIds.length && !agentIds.length) throw new AttachRefused(400, 'itsas or agents is required');
  db.linkMailItsas(mailId, itsaIds.map((itsa_id) => ({ itsa_id, source: 'attached' as const })));
  return { itsas: itsaIds, agents: db.attachMailAgents(mailId, agentIds, by) };
}
