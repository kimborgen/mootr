// Withdrawing an ask from the human once someone else has settled it (S-413): a parent
// approved the permission, or an agent moved the ITSA on, so the mail no longer needs the
// human. The human's copy is marked read and carries who withdrew it and the line the thread
// shows, the thread is archived here (a later reply brings it back), and the phones close its
// notifications. The human's own answer never comes here: it is theirs to read.
import * as db from './db.ts';
import { HUMAN } from './mail.ts';
import { closeThread, closeLocal as pushClose } from './webpush.ts';
import { peers, peerCall } from './peers.ts';

const log = (what: string, e: unknown) => console.error(`withdraw: ${what}: ${e instanceof Error ? e.message : e}`);

export interface Withdrawn {
  id: string;
  thread_id: string;
  // The ids of the thread's mail the holder had when it settled this one (set by the daemon that holds the mail).
  ids?: string[];
}

// Withdraws these mails from the human. The ones the human doesn't hold here go to each
// peer (unless this call is a peer's: `fromPeer`). Returns the mails withdrawn anywhere.
//
// Archive records the thread's mail by identity, taken by the daemon that holds the mail in the same
// step that withdraws it, never by a clock: a reply that arrives later, whatever its timestamp, isn't
// in the set, so it keeps its thread open (S-413). Mail on other machines that this settlement didn't
// see keeps the thread listed (read, with the withdrawn line), which is the safe side. A close names
// only the mails withdrawn, so a reply's notification stays. A peer that holds the mail closes its own
// devices' notifications; this daemon closes its own and tells the other peers, who confirm with the holder.
export async function withdrawFromHuman(mailIds: string[], by: string, note: string, opts: { fromPeer?: boolean; keepThread?: boolean; closeKept?: boolean } = {}): Promise<Withdrawn[]> {
  const { fromPeer = false, keepThread = false, closeKept = false } = opts;
  if (by === HUMAN) throw new Error("the human's own answer isn't withdrawn");
  const ids = [...new Set(mailIds)];
  if (!ids.length) return [];
  const { held, fresh } = db.withdrawFromHuman(ids, by, note);
  // The same step: no await between withdrawing the mail and recording what its thread holds.
  const done: (Withdrawn & { holder?: string })[] = fresh.map((f) => ({ ...f, ids: db.threadMail(f.thread_id).map((m) => m.id) }));
  const missing = ids.filter((id) => !held.includes(id));
  if (missing.length && !fromPeer) {
    const rest = await Promise.all(peers().map((p) => peerCall(p, 'POST', '/api/mail/withdraw', { ids: missing, by, note, keep_thread: keepThread, close_kept: closeKept }).then((r) => (Array.isArray(r.data?.withdrawn) ? (r.data.withdrawn as Withdrawn[]).map((w) => ({ ...w, holder: p.name })) : []), () => [] as (Withdrawn & { holder: string })[])));
    done.push(...rest.flat());
  }
  // keepThread: a new ask joins the same thread at once, so the thread stays open and its notification stays.
  // closeKept: the withdrawn mails' notifications close by id, while the thread stays open and listed
  // (a superseded mail whose replacement may start another thread, S-1304).
  if (keepThread && !closeKept) return done;
  const byThread = new Map<string, (Withdrawn & { holder?: string })[]>();
  for (const w of done) byThread.set(w.thread_id, [...(byThread.get(w.thread_id) ?? []), w]);
  for (const [t, ws] of byThread) {
    if (!keepThread) db.archiveThread(HUMAN, t, [...new Set(ws.flatMap((w) => [w.id, ...(w.ids ?? [])]))]);
    // A peer's own call closes only its devices; the daemon that started the withdrawal tells the rest.
    if (fromPeer) pushClose(t, ws.map((w) => w.id));
    else for (const [holder, group] of Object.entries(Object.groupBy(ws, (w) => w.holder ?? ''))) closeThread(t, group!.map((w) => w.id), holder || undefined);
  }
  return done.map(({ id, thread_id, ids }) => ({ id, thread_id, ids }));
}

// The hooks' form: a failure is logged, never thrown into the answer that caused it.
export function withdrawQuietly(mailIds: string[], by: string, note: string, opts: { keepThread?: boolean } = {}): void {
  withdrawFromHuman(mailIds, by, note, opts).catch((e) => log(note, e));
}

// A refusal the caller gets as its status and message (withdrawAsk).
export class AskRefused extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The sender withdraws its own ask from the human (withdraw_ask, S-425): a decision mail stops
// waiting, leaving the decision list, and the human's copy is withdrawn as any settlement. A
// permission request and an ITSA ask settle through answer_permission and the ITSA's human status,
// which withdraw on their own, so they're refused here with the path to take. A decision the human
// deferred (Decide later) stays with them. Only the sender, its parent, the chief of staff or the
// assistant may withdraw; `boss` says the caller is the latter two. `reason` is the caller's own words.
// A mail this daemon doesn't hold goes to the peer that does, as the same caller (unless it came from a
// peer already, `fromPeer`, which then gets the 404).
export async function withdrawAsk(mailId: string, by: string, reason: string, opts: { boss: boolean; fromPeer?: boolean; byName?: string }): Promise<Withdrawn[]> {
  const m = db.getMail(mailId);
  if (!m) {
    if (opts.fromPeer) throw new AskRefused(404, `no mail ${mailId}`);
    return forwardWithdrawAsk(mailId, by, reason, opts.boss, db.getAgent(by)?.name ?? db.findPeerAgent(by)?.name ?? by);
  }
  const sender = db.getAgent(m.from_id);
  if (!(opts.boss || m.from_id === by || (sender && db.parentsOf(sender).includes(by))))
    throw new AskRefused(403, 'only the agent that sent the mail, its parent, the chief of staff or the assistant may withdraw it');
  if (!db.open().prepare("SELECT 1 AS n FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'").get(mailId)) throw new AskRefused(409, `${mailId} wasn't sent to the human`);
  if (m.permission_id) throw new AskRefused(409, `${mailId} is a permission request: answer it with answer_permission`);
  if (m.kind === 'ask') throw new AskRefused(409, `${mailId} is an ITSA ask: move the ITSA out of its human status, which withdraws it`);
  if (!db.decisionMailOpen(mailId)) throw new AskRefused(409, `${mailId} isn't waiting on the human: it is answered, already withdrawn, or not a decision mail`);
  if (m.thread_id && db.isThreadDeferred(m.thread_id)) throw new AskRefused(409, `${mailId} is one the human deferred (Decide later), so it stays with them`);
  db.removeDecisionMail(mailId);
  // The name the caller's daemon knows the agent by, when this one doesn't (a chief of staff on a peer).
  const name = db.getAgent(by)?.name ?? db.findPeerAgent(by)?.name ?? opts.byName ?? by;
  return withdrawFromHuman([mailId], by, reason.trim() ? `Withdrawn by @${name}: ${reason.trim()}` : `Withdrawn by @${name}`);
}

// The peer that holds the mail settles it for this caller: the forwarded request names the caller as
// its agent, and its boss flag, which the peer trusts as it does for any forwarded request (S-239).
async function forwardWithdrawAsk(mailId: string, by: string, reason: string, boss: boolean, byName: string): Promise<Withdrawn[]> {
  for (const p of peers()) {
    const r = await peerCall(p, 'POST', `/api/mail/${encodeURIComponent(mailId)}/withdraw-ask`, { note: reason, by_name: byName }, 8000, false, { agent: by, boss }).catch(() => undefined);
    if (!r) continue;
    if (r.status === 200) return Array.isArray(r.data?.withdrawn) ? (r.data.withdrawn as Withdrawn[]) : [];
    if (r.status !== 404) throw new AskRefused(r.status, String(r.data?.error ?? `HTTP ${r.status}`));
  }
  throw new AskRefused(404, `no mail ${mailId}`);
}
