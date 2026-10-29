// What happens when an ITSA waits on the human: entering a status flagged `human` adds the
// human as a participant and mails them once, in the ITSA's thread (templates/itsa-human.md),
// saying what is asked and carrying the owner's latest comment. The web UI shows the
// matching action buttons (settings.itsa.actions) on that mail and in the ITSA's header; an
// action moves the ITSA to its target status and posts the human's text as a comment that
// interrupts the owner. `attention` lists the ITSAs waiting on the human, oldest first, for
// the merged attention list. See docs/itsa-design.md.
import * as db from './db.ts';
import * as itsa from './itsa.ts';
import { HUMAN, stamSender, type RelayRoute } from './mail.ts';
import { render } from './templates.ts';
import { withdrawQuietly } from './withdraw.ts';

const log = (what: string, e: unknown) => console.error(`ITSA human: ${what}: ${e instanceof Error ? e.message : e}`);

// The latest comment or update `who` left in the thread since the previous status change, or none.
// An older comment was about an earlier stop, so the ask doesn't repeat it.
function latestMail(x: itsa.Itsa, who: string): db.Mail | undefined {
  const mails = x.thread_id ? db.threadMail(x.thread_id) : [];
  const since = itsa.statusSince(x, 1);
  return mails.findLast((k) => k.from_id === who && (k.kind === 'comment' || k.kind === 'update') && k.created_at >= since);
}

// The latest comment as the owner wrote it (plain Markdown, so its decision blocks render), or a line saying there is none.
function latestComment(m: db.Mail | undefined): string {
  if (!m) return 'The owner left no comment.';
  return m.body.trim();
}

// The ITSA's text as a mail shows it (S-2998): its title, summary and body, in a <details> block,
// and the revision of exactly that snapshot (itsa.revOf). The title and summary, plain text in the
// ITSA view, are escaped, so markup in them can't hide the rest; the body is Markdown in both. A
// body longer than ASK_TEXT_MAX (UTF-16 units, as JS counts) is cut, with a line to open the ITSA,
// and has no revision: an Approve from that mail is then refused, and the ITSA view is the way to approve.
export const ASK_TEXT_MAX = 4000;
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function shownText(x: Pick<itsa.Itsa, 'key' | 'title' | 'summary' | 'body'>): { text: string; rev?: string } {
  const body = x.body ?? '';
  const cut = body.length > ASK_TEXT_MAX;
  const parts = [x.summary && escHtml(x.summary), cut ? `${body.slice(0, ASK_TEXT_MAX)}\n\n… Cut here: open ${x.key} to review all of it.` : body].filter((s): s is string => !!s && !!s.trim());
  const text = [`<details><summary>What you approve: ${x.key} ${escHtml(x.title)}</summary>`, '', ...(parts.length ? parts.flatMap((s) => [s, '']) : ['(no summary or body)', '']), '</details>'].join('\n');
  return cut ? { text } : { text, rev: itsa.revOf(x) };
}

// Mails the human about an ITSA that just entered a human status. The sender is the agent
// that made the change, else the owner, else the agent standing in for stam.
export async function askHuman(x: itsa.Itsa, actor: string, route?: RelayRoute): Promise<void> {
  const st = itsa.statusOf(x.status);
  if (!st?.human) return;
  const isAgent = (id: string | null): id is string => !!id && id !== HUMAN;
  const sender = isAgent(actor) ? actor : isAgent(x.owner) ? x.owner : stamSender()?.id;
  if (!sender) return;
  itsa.ensureParticipant(x.id, HUMAN);
  const actions = itsa.actionsOf(x.status).map((a) => a.label);
  // The owner's comment this ask repeats: the ask replies to it, so the thread view can fold it.
  const repeated = latestMail(x, sender);
  const stamAsks = !isAgent(actor) && !isAgent(x.owner);
  // The ask shows the text it asks about, from this snapshot, and records its revision (S-2998). It
  // comes first, so no markup in the owner's comment can hide it, and the title is escaped.
  const shown = shownText(x);
  const body = shown.text + '\n\n' + render('itsa-human', {
    // The mail reads as a mail to the human: it names who asks (stam itself when no agent owns the ITSA).
    asker: stamAsks ? 'stam' : db.getAgent(sender)?.name ?? sender,
    key: x.key,
    title: escHtml(x.title),
    status: x.status.replace(/_/g, ' '),
    latest: latestComment(repeated),
    actions: actions.length ? actions.join(', ') : 'reply here',
  });
  // A question stam asks in an agent's name (no agent owns the ITSA) is stam's own mail: it never starts a peer.
  await itsa.post(x.id, { by: sender, body, subject: `${x.key} ${x.title}`, from_stam: stamAsks, reply_to: repeated?.id, relay_route: route }, { ask: true, shown });
}

// Registered once with the daemon: a status change by an agent into a human status mails
// the human. The human's own changes don't (they know); the actions below call askHuman for
// the status they move to.
export function watchHumanStatuses(): void {
  itsa.onStatus(onStatus);
}

// The latest ask mail to the human about the ITSA, whenever it was sent and not yet withdrawn: the
// one an agent's move out of a human status settles.
function lastAsk(x: itsa.Itsa): { id: string } | undefined {
  return db.open().prepare(`SELECT m.id FROM mail m JOIN mail_recipients r ON r.mail_id = m.id AND r.agent_id = ? AND r.withdrawn_at IS NULL
    WHERE m.about_itsa = ? AND m.kind = 'ask' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`).get(HUMAN, x.id) as { id: string } | undefined;
}

// The ITSA whose thread this is, while it waits on the human (S-3080): a wait_for on the human in that
// thread is tied to it, and clears when the ITSA leaves the status.
export function waitingItsaOfThread(threadId: string): string | undefined {
  const x = db.open().prepare('SELECT id, status FROM itsas WHERE thread_id = ?').get(threadId) as { id: string; status: string } | undefined;
  return x && itsa.statusOf(x.status)?.human ? x.id : undefined;
}

// Whether the ITSA a wait on the human is tied to has left its human status, or is gone (S-3080). A read
// that fails keeps the wait: only a row that says so settles it.
export function itsaAskSettled(id: string): boolean {
  try {
    const x = db.open().prepare('SELECT status FROM itsas WHERE id = ?').get(id) as { status: string } | undefined;
    return !x || !itsa.statusOf(x.status)?.human;
  } catch (e) {
    log(`wait tied to ${id} kept, its ask couldn't be read`, e);
    return false;
  }
}

export function onStatus(x: itsa.Itsa, actor: string, from: string, route?: RelayRoute): void {
  if (from === x.status) return;
  // Leaving a human status for a non-human one settles the ask whoever moved the ITSA, so the agent's wait on it
  // goes too (S-3080). A move between human statuses asks again, and the wait stays tied to the ITSA.
  const leaving = !!itsa.statusOf(from)?.human;
  if (leaving && !itsa.statusOf(x.status)?.human) for (const agent of db.humanWaitersOf(x.id)) db.clearRequestWaits(agent, x.id);
  if (actor === HUMAN) return;
  // An agent moved the ITSA out of a human status: the human's ask is settled without them. This runs
  // before a new ask is mailed, so the old one is the latest.
  if (leaving) {
    const ask = lastAsk(x);
    if (ask) withdrawQuietly([ask.id], actor, `@${db.getAgent(actor)?.name ?? actor} moved ${x.key} to ${x.status}`, { keepThread: !!itsa.statusOf(x.status)?.human });
  }
  // An ask refused after the move committed (S-4178) is recorded on the ITSA, so the stuck ask can be seen, not only in a log.
  askHuman(x, actor, route).catch((e) => {
    log(`mail for ${x.key}`, e);
    itsa.addEvent(x.id, null, 'ask_refused', { to: x.status, error: e instanceof Error ? e.message : String(e) });
  });
}

export interface Attention extends itsa.Itsa {
  // When it entered its current status.
  since: string;
  actions: itsa.HumanAction[];
  // The latest ask mail to the human about it (kind `ask`) since it entered this status, which
  // the mail list shows as the ITSA's row. It always sits in the ITSA's own thread; null if none.
  ask_thread_id: string | null;
  ask_mail_id: string | null;
  // The human deferred the ask's thread (S-353): it stays open, off the waiting list.
  deferred: boolean;
}

// The ITSAs in a human status.
function waiting(): itsa.Itsa[] {
  const names = itsa.statuses().filter((s) => s.human).map((s) => s.name);
  if (!names.length) return [];
  return db.open().prepare(`SELECT * FROM itsas WHERE status IN (${names.map(() => '?').join(', ')})`).all(...names) as unknown as itsa.Itsa[];
}

// The latest ask mail to the human about the ITSA since it entered its current status: an ask
// from an earlier status is stale and points nowhere.
function latestAsk(x: itsa.Itsa): { id: string; thread_id: string } | undefined {
  return db.open().prepare(`SELECT m.id, m.thread_id FROM mail m JOIN mail_recipients r ON r.mail_id = m.id AND r.agent_id = ?
    WHERE m.about_itsa = ? AND m.kind = 'ask' AND m.created_at >= ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`)
    .get(HUMAN, x.id, itsa.statusSince(x)) as { id: string; thread_id: string } | undefined;
}

// The ask threads of the ITSAs waiting on the human, which archive can't hide (the human's
// thread list asks for them on every load, so this skips attention's event scan).
export function askThreadIds(): Set<string> {
  return new Set(waiting().flatMap((x) => latestAsk(x)?.thread_id ?? []));
}

// The ids of the ITSAs in a human status: a read that needs only to know which ones wait.
export function waitingIds(): Set<string> {
  return new Set(waiting().map((x) => x.id));
}

// Every ITSA in a human status, oldest first.
export function attention(): Attention[] {
  const deferred = db.deferredThreadIds();
  return waiting()
    .map((x): Attention => {
      const e = itsa.events(x.id, 1000).findLast((v) => v.type === 'status' && v.data && JSON.parse(v.data).to === x.status);
      const ask = latestAsk(x);
      return { ...x, since: e?.ts ?? x.created_at, actions: itsa.actionsOf(x.status), ask_thread_id: ask?.thread_id ?? null, ask_mail_id: ask?.id ?? null, deferred: !!ask && deferred.has(ask.thread_id) };
    })
    .sort((a, b) => a.since.localeCompare(b.since));
}

// The human takes an action on an ITSA waiting on them. The text (a comment to the
// participants, interrupting the owner) is posted first: if delivery fails, nothing has
// changed and the human can retry. The status then moves only if the ITSA is still in the
// status the action was offered for (a stale button gets 409; the comment stays, which is
// harmless). Returns the updated ITSA and the action taken. Approve's text is posted after its
// move instead, so a refused Approve leaves no comment.
//
// Approve carries `ifRev`, the revision of the text it showed (itsa.revOf, S-2998): text that
// changed since, or no revision at all (a page loaded before Approve sent one), refuses it before
// anything is posted, and the status move checks it again in the same transaction. A mail thread,
// which doesn't show the body, names the newest mail it shows instead (`shownMail`): the revision
// is the one recorded on the ask or re-ask at or before it (itsa.shownRev).
export async function act(ref: string, actionId: string, text: string, ifRev?: string, shownMail?: string): Promise<{ itsa: itsa.Itsa; action: itsa.HumanAction }> {
  const x = itsa.must(ref);
  const action = itsa.actionsOf(x.status).find((a) => a.id === actionId);
  if (!action) throw new Error(`${x.key} is in ${x.status}, which has no action ${actionId}`);
  const approve = action.id === 'approve';
  if (approve && !ifRev && shownMail) ifRev = itsa.shownRev(x.id, shownMail);
  if (approve && (!ifRev || ifRev !== itsa.revOf(x))) throw new Error(`${itsa.TEXT_CHANGED}: ${ifRev ? `${x.key} changed since it was shown` : `Approve didn't say which text of ${x.key} it saw; reload it`}`);
  const body = String(text ?? '').trim();
  if (action.text === 'required' && !body) throw new Error(`${action.label} needs a comment: say what you want`);
  if (action.text === 'none' && body) throw new Error(`${action.label} takes no comment`);
  // Approve's comment goes only after its guarded move succeeds, so a refusal leaves nothing behind.
  if (body && !approve) await itsa.post(x.id, { by: HUMAN, body });
  const r = await itsa.set(x.id, { status: action.to, ifStatus: x.status, action: action.id, ...(approve ? { ifRev } : {}) }, HUMAN);
  if (body && approve) await itsa.post(x.id, { by: HUMAN, body });
  return { itsa: r.itsa, action };
}
