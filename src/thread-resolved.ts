// When a thread in the human's inbox is resolved (S-637): someone else handled it, so it can be
// archived for them. Pure: the caller passes the thread as the human's list merges it, and what it
// knows about the thread's ITSAs and decision mails. The definition is the chief of staff's, and
// conservative; a thread is resolved only when all of these hold:
//   - it is about an ITSA (a mail's itsa_id or about_itsa), and every such ITSA is closed;
//   - no ask in it still waits: no pending permission request, no open decision mail;
//   - the last mail between the human and anyone in it is the human's own, written before the ITSA
//     closed (the closing answers it; a follow-up after it waits), or an agent's end result: a mail
//     to the human that asks nothing (not an ITSA ask, a decision, or a question ending in "?"; a
//     request in it is settled by the clause before);
//   - the human has read every mail to them in it, so archiving never hides news they haven't seen;
//   - no agent waits on the human for it (an open wait_for on them, or one tied to a request in it).
// A thread about no ITSA that holds permission requests is resolved when every request in it is
// answered, withdrawn or expired, the human has read every mail to them in it (cos, S-637), and the
// last mail on their side is a request: their own mail, or an agent's after the requests, waits.
// Plain mail about no ITSA and no request is never resolved this way.
// Mail withdrawn from the human (S-413) counts as handled. Mail between others in the thread
// doesn't count, as with archive (S-542). An archived thread comes back with the next mail to the
// human (db.splitArchived), so a later question reopens it.
import { hasDecisionBlock } from './decision-mail.ts';

export const HUMAN = 'human';

export interface ResolvedMail {
  id: string;
  from_id: string;
  created_at: string;
  kind?: string | null;
  body?: string;
  itsa_id?: string | null;
  about_itsa?: string | null;
  permission_id?: string | null;
  permission?: { status?: string } | null;
  recipients?: { id: string; read_at: string | null; withdrawn_at?: string | null }[];
}

export interface ResolvedContext {
  // When the ITSA closed; null while it is open, and undefined when it isn't known here, which counts as open.
  itsaClosedAt: (itsaId: string) => string | null | undefined;
  // Whether this mail is a decision mail that still waits on the human (a deferred one too).
  decisionOpen: (mailId: string) => boolean;
  // Whether an agent waits on the human for this thread: an open wait_for on them naming it, or one
  // tied to a request or mail in it. A wait this can't place in a thread counts for every thread (S-637).
  humanWaited: (thread: { thread_id: string; mails: ResolvedMail[] }) => boolean;
}

// `kind` says which rule resolved it: a closed ITSA's, or a request thread's.
export type Resolved = { resolved: true; kind: 'itsa' | 'request' } | { resolved: false; why: string };

const no = (why: string): Resolved => ({ resolved: false, why });
const toHuman = (m: ResolvedMail) => m.recipients?.find((r) => r.id === HUMAN);

export function threadResolved(thread: { thread_id: string; mails: ResolvedMail[] }, ctx: ResolvedContext): Resolved {
  const mails = [...thread.mails].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (ctx.humanWaited(thread)) return no('an agent waits on the human for it');
  const itsas = new Set(mails.map((m) => m.itsa_id ?? m.about_itsa).filter((x): x is string => !!x));
  const requests = mails.some((m) => m.permission_id);
  if (!itsas.size && !requests) return no('it is about no ITSA and holds no request');
  let closedAt = '';
  for (const id of itsas) {
    const at = ctx.itsaClosedAt(id);
    if (!at) return no(`ITSA ${id} is open`);
    if (at > closedAt) closedAt = at;
  }
  // A request whose state isn't known here (it lives on a peer that didn't answer) counts as pending.
  for (const m of mails) if (m.permission_id && (m.permission?.status ?? 'pending') === 'pending') return no(`request ${m.permission_id} isn't settled`);
  for (const m of mails) if (ctx.decisionOpen(m.id)) return no(`decision ${m.id} is open`);
  // The human's side of the thread: what they sent, and what was sent to them and not withdrawn.
  const theirs = mails.filter((m) => m.from_id === HUMAN || (toHuman(m) && !toHuman(m)!.withdrawn_at));
  const unread = theirs.find((m) => m.from_id !== HUMAN && !toHuman(m)!.read_at);
  if (unread) return no(`the human hasn't read ${unread.id}`);
  const last = theirs.at(-1);
  // A request thread ends with a request: the human's own mail, or an agent's after the requests, waits for an answer.
  // With every mail to the human withdrawn (someone else answered), nothing is left for them.
  if (!itsas.size) return !last || last.permission_id ? { resolved: true, kind: 'request' } : no(`the last mail on the human's side, ${last.id}, isn't a request`);
  if (!last) return { resolved: true, kind: 'itsa' };
  // The human's own last mail is answered by the ITSA closing after it; one written after, a follow-up, waits.
  if (last.from_id === HUMAN) return last.created_at <= closedAt ? { resolved: true, kind: 'itsa' } : no(`the human wrote ${last.id} after the ITSA closed`);
  // An agent's question, with or without a decision block, waits for the human's answer (S-637, m6d0b925).
  if (/\?\s*$/.test(last.body ?? '')) return no(`the last mail to the human, ${last.id}, asks them a question`);
  // A settled request asks nothing any more; an ITSA ask or a decision someone else settled is
  // withdrawn from the human (S-413), so one still here is left for them.
  if (last.kind === 'ask' || hasDecisionBlock(last.body ?? '')) return no(`the last mail to the human, ${last.id}, asks them something`);
  return { resolved: true, kind: 'itsa' };
}
