import { join, basename } from 'node:path';
import { mkdirSync, writeFileSync, copyFileSync, statSync, readFileSync } from 'node:fs';
import { STAM_HOME } from './config.ts';
import * as db from './db.ts';
import { render } from './templates.ts';
import { adapters } from './adapters/index.ts';
import { peers, peerByName, findAgentPeer, locateAgent, peerHits, pickAgent, isLive, peerCall, ensureUp, fanOut, fanOutReport, refuseAmbiguousId, type AgentHit, type Peer, type Via } from './peers.ts';
import { checkCanMail, chiefOfStaff, reachable } from './org.ts';
import { descendantsOf } from './tree.ts';
import { mayReadMail } from './mail-visibility.ts';
import { linkMail } from './mail-itsas.ts';
import { mayMailHuman, settings } from './settings.ts';
import { apiKey } from './credits.ts';
import { capturePaneAnsi, hasSession } from './tmux.ts';
import { admit } from './admission.ts';
import { onHumanMail } from './webpush.ts';
import { maybeCheckMail, gateMail, gateFailures } from './mail-check.ts';
import { maybeCheckMail as maybeCheckRequirements } from './req-check.ts';
import { maybeTitleMail } from './mail-title.ts';
import { hasDecisionBlock, isDeferralOnly } from './decision-mail.ts';
import { indexMail } from './vectors.ts';
import * as events from './events.ts';
import { embedFiles } from './mail-embed.ts';

export const HUMAN = 'human';
// About 5,000 tokens at roughly 4 characters per token. Overflow becomes an attachment.
const BODY_LIMIT_CHARS = Number(process.env.STAM_MAIL_BODY_CHARS ?? 20_000);
const PUSH_DEBOUNCE_MS = 2000;
const NOTICE_LIST = 10;

export interface Attachment {
  name?: string;
  path?: string;
  content?: string;
  content_b64?: string;
}

export interface SendInput {
  from: string;
  to: string[];
  subject: string;
  body: string;
  attachments?: Attachment[];
  // The mail this one answers; the reply joins its thread.
  reply_to?: string;
  // Starts a new thread even where the mail looks like a reply.
  new_thread?: boolean;
  // The exact id of an earlier mail of the sender's own that this one replaces (S-1304): it stays in
  // its thread, but leaves every inbox, unread count and notification, and its ask is withdrawn.
  supersedes?: string;
  // Set on the mail that carries a permission request.
  permission_id?: string;
  // Set by a peer daemon forwarding mail, which resolved the thread on its side.
  thread_id?: string;
  // Set by a peer daemon forwarding mail from one of its agents.
  forwarded?: { from_name: string };
  // A local script's name (the deploy watcher, S-436): the mail is from `system:NAME`, a sender no agent owns.
  // Only the human's local CLI may send it (POST /api/mail refuses it from an agent).
  system?: string;
  // The daemon guessed the thread this answers; carries through forwarding, and the
  // UI shows it so a guessed thread is visible next to a reply_to the agent named.
  auto_threaded?: boolean;
  // An ITSA comment or update, posted by itsa.post (never set by an agent directly): the
  // ITSA, the kind (`comment` or `update`), and an update's health. The thread is the ITSA's.
  itsa_id?: string;
  kind?: string;
  health?: string;
  // The ITSA this mail is about, by key or id (S-91). sendMail resolves it to the id (stored
  // as about_itsa), and it carries through forwarding. Mail in an ITSA's own thread is about
  // that ITSA without it.
  itsa?: string;
  about_itsa?: string;
  // Recipients (ids) that this ITSA mail interrupts a working agent for; the others get it
  // with the idle batch. Computed on the ITSA's home daemon and carried through forwarding.
  interrupt?: string[];
  // The ITSA's home daemon sends for an agent on another machine: the sender is a peer's
  // agent (`forwarded` names it), but recipients are resolved here, local or remote.
  relay?: boolean;
  // The id the sending daemon gave this mail, set when it forwards: every daemon stores the
  // mail under it, so a thread merged from several daemons shows it once.
  mail_id?: string;
  // Set on mail stam sends on its own behalf (sendFromStam): its sender is a stand-in agent,
  // not the agent it really is, so such mail must never clear a declared wait (mail.ts).
  from_stam?: boolean;
  // The title the sending daemon's model gave the mail (S-297), on a forward that waited in the
  // outbox until the title was known. Taken only from a peer's forward.
  title?: string;
  // Likewise the one-line summary of a mail to the human (S-1001).
  summary?: string;
  // The recipients in `to` the sender didn't name: a reply's fan-out to the thread's people (the
  // web UI's reply, an ITSA's participants). One nobody can mail any more (archived where its
  // machine doesn't answer, or forgotten) is skipped, not refused; only a named one is (S-603).
  // Only stam sets it: POST /api/mail refuses it from an agent's token, which would otherwise
  // pass a named recipient off as inferred and skip the refusal (S-608).
  inferred?: string[];
  // The mail gate (S-983): an agent's mail to the human is checked by the decision model before it
  // is stored, and a fail refuses it. This reason sends it anyway; it is stored on the mail and shown to the human.
  override?: string;
  // The human sent this without picking a recipient, so it went to the default top-level agent (S-1462):
  // the stored mail carries the routing-uncertain note for the recipient. Ignored from anyone but the human.
  routing_uncertain?: boolean;
  // What the main world showed when the human wrote from the bottom bar's suggestion mode (S-1474): one plain line.
  // The stored mail carries the looking-at note for the recipient. Ignored from anyone but the human.
  looking_at?: string;
}

// The looking-at note for what the human was looking at; '' when raw isn't a string or is blank.
export function lookingAtNote(raw: unknown): string {
  const at = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return at ? render('looking-at', { context: at }) : '';
}

// The system notes the human's own mail carries for its recipient: routing uncertain (S-1462) and what the human was looking at (S-1474).
function humanNote(input: SendInput, from: string): string | null {
  if (from !== HUMAN) return null;
  const notes: string[] = [];
  if (input.routing_uncertain === true) notes.push(render('routing-uncertain', {}));
  const at = lookingAtNote(input.looking_at);
  if (at) notes.push(at);
  return notes.length ? notes.join('\n\n') : null;
}

const base = (subject: string) => subject.replace(/^(re:\s*)+/i, '').trim().toLowerCase();
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

// The mail an agent's message most likely answers, when it named none:
// 1. a mail from a recipient the agent read in the last 30 minutes and hasn't answered;
// 2. for a subject that's empty or starts with "Re:", or one that matches a thread's
//    subject, the latest such thread with a recipient in the last week.
// A new subject that matches nothing starts a new thread.
// When the agent read several threads in the last 30 minutes and didn't name one,
// which it means is ambiguous: ask it, listing the threads, instead of guessing.
function guessParent(from: string, to: string[], subject: string) {
  const senders = to.filter((t) => t !== 'all').map((t) => (t === HUMAN ? HUMAN : (db.getAgent(t)?.id ?? t)));
  const recent = db.mailFrom(from, senders, minutesAgo(7 * 24 * 60));
  const justRead = recent.filter((m) => !m.answered && m.read_at && m.read_at > minutesAgo(30));
  const s = base(subject ?? '');
  // A subject that names one of the threads read in the last 30 minutes settles it.
  if (justRead.length) {
    const bySubject = justRead.find((m) => s && (base(m.root_subject) === s || base(m.subject) === s));
    if (bySubject) return bySubject;
    const threads = new Set(justRead.map((m) => m.thread_id ?? m.id));
    if (threads.size > 1) {
      const list = justRead.map((m) => `"${m.subject}" (${m.id})`).join(', ');
      throw new Error(`Your mail could answer any of ${threads.size} threads you read in the last 30 minutes: ${list}. Pass reply_to to say which one you mean.`);
    }
    return justRead[0];
  }
  const sameSubject = s && recent.find((m) => base(m.root_subject) === s || base(m.subject) === s);
  if (sameSubject) return sameSubject;
  if (!subject || /^re:/i.test(subject)) return recent.find((m) => !m.answered) ?? recent[0];
  return undefined;
}

// What an unthreaded send from `from` would thread into depends on the mail it has read in the last 30
// minutes (guessParent), which the send's own text doesn't show. The dedup of a retried send (S-1663)
// adds this to its key: the same words sent after reading other mail go to another thread and are
// another send, while a retry reads nothing in between and keeps the key.
export function readEpoch(from: string): string {
  return db.lastReadSince(from, minutesAgo(30));
}

// Sends to local recipients directly and forwards the rest to the daemons that own them.
// A ```pane block names an agent (or a terminal, sh-…); the sender's daemon fills in that
// agent's screen as it is now, so the mail keeps the moment. Agents on another machine stay
// a plain link.
function capturePanes(body: string): string {
  return body.replace(/```pane[^\S\n]*\n([^\n]*)\n(?:(?!```)[^\n]*\n)*?```/g, (all, ref: string) => {
    const name = ref.trim().replace(/^@/, '');
    const id = /^sh-/.test(name) ? name : db.getAgent(name)?.id;
    if (!id || !hasSession(id)) return all;
    try {
      const screen = capturePaneAnsi(id).replace(/```/g, '`\u200b``');
      return '```pane\n' + `${name}\ncaptured: ${new Date().toISOString()}\n---\n${screen}\n` + '```';
    } catch {
      return all;
    }
  });
}

// An agent whose model may not mail the human (settings.humanMail.models): its name, model, and
// the parent that hears instead, the first parent or else the chief of staff. An agent on a peer
// is looked up there, and its parent is named only when it is on this daemon. Undefined otherwise.
export async function humanMailBlock(agentId: string): Promise<{ name: string; model: string; parent?: string } | undefined> {
  const local = db.getAgent(agentId);
  const a = local ?? (await findAgentPeer(agentId))?.agent;
  if (!a || mayMailHuman(a.model)) return undefined;
  const parentId = local ? db.parentsOf(local)[0] ?? chiefOfStaff()?.id : undefined;
  const parent = parentId ? db.getAgent(parentId)?.name ?? parentId : undefined;
  return { name: a.name, model: a.model!, parent };
}

// What a name in `to` means (S-288): the agent with that exact id or name, here or on a peer. An id
// beats any name, and a live one beats one that is shut down. 'absent' when no agent has it, 'unreachable' when a peer that didn't answer may.
// `skipPeers` looks only here, as for mail a daemon forwards for an agent that is already routed.
export async function resolveRecipient(ref: string, skipPeers = false): Promise<AgentHit | 'absent' | 'unreachable'> {
  const local = db.getAgent(ref);
  // Without a peer round trip, in this order: an exact local id, an exact id remembered from a
  // peer (peer_agents), then a live local name (cos, S-288). Only then the peers are asked.
  // An id that a peer's agent also has can't be told apart (S-577): refuse it, naming both,
  // rather than silently resolving to the local one.
  if (local?.id === ref) {
    refuseAmbiguousId(ref, local);
    return { agent: local };
  }
  // A forwarded send is already routed, so it skips the peers here too. An archived one takes the
  // normal path, which refuses it when its peer is down rather than queueing mail for it.
  const remembered = db.findPeerAgent(ref);
  const lifecycle = remembered && db.peerAgentLifecycle(remembered.id);
  const remotePeer = remembered?.id === ref && !skipPeers && lifecycle !== 'archived' ? peerByName(remembered.machine) : undefined;
  if (remembered && remotePeer) return { peer: remotePeer, agent: { ...remembered, lifecycle: (lifecycle ?? 'active') as db.Lifecycle } };
  // A remembered exact id, even an archived one, is not a name: a local agent of that name doesn't stand in for it.
  const named = remembered?.id === ref ? undefined : local;
  if (named && isLive(named)) return { agent: named };
  const peer = skipPeers ? { hits: [], unreachable: false } : await peerHits(ref);
  const hit = pickAgent(ref, [...(named ? [{ agent: named }] : []), ...peer.hits]);
  return hit ?? (peer.unreachable ? 'unreachable' : 'absent');
}

// What sendMail returns: the stored mail, or for mail queued for a peer that doesn't answer, its id,
// thread, and recipients with queued set (S-235).
// not_running (S-384): the names of recipients the sender named whose harness isn't running, so the mail waits unread.
// rerouted (S-548): the name of the parent that got mail the sender addressed to the human.
// misses_human (S-542): an agent's reply to the human's mail that doesn't name the human, so it stays out of their inbox.
// skipped (S-603): the inferred recipients the mail skipped because nobody can mail them any more.
export type SentMail = (db.Mail | { id: string; thread_id: string; to: string[]; queued: true }) & { not_running?: string[]; rerouted?: string; misses_human?: true; skipped?: string[] };

// The fields a reply to a mail takes from it (GET /api/mail/:id).
// The SendInput fields only stam sets: a peer forwarding mail, the human's web reply, or the
// daemon calling sendMail itself. POST /api/mail refuses them from an agent's token (S-466).
// `inferred` is among them (S-608): an agent that named it could mark a recipient it named as
// one the sender didn't, turning that recipient's refusal into a silent skip.
export const DAEMON_FIELDS = ['forwarded', 'relay', 'thread_id', 'itsa_id', 'mail_id', 'from_stam', 'permission_id', 'interrupt', 'inferred', 'kind', 'health', 'auto_threaded', 'about_itsa', 'title', 'summary', 'system'] as const;

export type ReplyParent = Pick<db.Mail, 'id' | 'thread_id' | 'subject' | 'from_id' | 'itsa_id'>;

// The mail a reply names: this daemon's copy, or the one a peer keeps (its recipient's machine).
// Either is found only if the sending agent may see it (mail-visibility.ts; S-359 on a peer, S-466
// here); unreachable says a peer couldn't be asked, so the caller can say so when nothing answers.
// hidden says a daemon keeps the mail but the agent isn't in its thread (S-400), so the error can
// say why rather than "no mail". The human and a local script (system:NAME; no via) see any mail.
async function parentOf(id: string, via?: Via): Promise<{ parent?: ReplyParent; unreachable: boolean; hidden?: boolean }> {
  const x = db.getMail(id);
  if (x && via && !via.boss && !mayReadMail(via.agent, x)) return { unreachable: false, hidden: true };
  if (x) return { parent: x, unreachable: false };
  const found = await fanOutReport<ReplyParent>(`/api/mail/${id}`, via);
  if (found.rows[0] || !via) return { parent: found.rows[0], unreachable: found.unreachable };
  const hidden = (await fanOut<{ thread_id: string }>(`/api/mail/${id}/thread`)).length > 0;
  return { unreachable: found.unreachable, hidden };
}

// A send that can't succeed as asked, however often it is tried (S-542): POST /api/mail answers 400,
// so the web outbox fails the row with its reason instead of retrying it.
export class RefusedError extends Error {}

// System senders that may never reach the human (local scripts any shared-token caller can name): the refusal comes before the mail
// gate, so the gate's exemption for system senders never applies to them.
const NEVER_MAILS_HUMAN = new Set(['system:full-suite']);

export async function sendMail(input: SendInput): Promise<SentMail> {
  // Models sometimes pass one recipient, or a comma-separated list, as a plain string.
  if (typeof input.to === 'string') input = { ...input, to: (input.to as string).split(',').map((t) => t.trim()).filter(Boolean) };
  // A system sender (system:NAME, a local script such as the deploy watcher) has no mailbox: a reply
  // that names it, as the web UI's reply to a thread it wrote in did (S-542), goes to the rest.
  if (input.to?.some((t) => t.startsWith('system:'))) input = { ...input, to: input.to.filter((t) => !t.startsWith('system:')) };
  // No `from` (a system sender, below) has no agent to look up.
  let from = input.from === HUMAN ? HUMAN : input.from ? db.getAgent(input.from)?.id : undefined;
  let fromName = from ? senderName(from) : undefined;
  if (!from && input.forwarded) {
    from = input.from;
    fromName = input.forwarded.from_name;
  }
  if (!from && input.system) {
    if (!/^[a-z][a-z-]{1,39}$/.test(input.system)) throw new Error(`bad system sender ${input.system}`);
    from = `system:${input.system}`;
    fromName = input.system;
  }
  if (!from) throw new Error(`no sender ${input.from}`);
  // The human's mail to an agent nobody has any more (forgotten, say) is refused up front, in
  // words the human can act on: the web outbox shows the reason and keeps the text (S-542).
  // A recipient the human didn't name (the thread's people, inferred) is skipped below instead (S-603).
  const inferred = new Set(input.inferred ?? []);
  if (from === HUMAN && !input.forwarded)
    for (const ref of input.to) {
      if (ref === HUMAN || ref === 'all' || inferred.has(ref) || (await resolveRecipient(ref)) !== 'absent') continue;
      const name = db.findPeerAgent(ref)?.name ?? db.lastSenderName(ref) ?? ref;
      throw new RefusedError(`${name} no longer exists. Reply to someone else, or copy your text.`);
    }
  if (input.supersedes && !input.forwarded) {
    const old = db.getMail(String(input.supersedes));
    if (!old) throw new RefusedError(`no mail ${input.supersedes} to supersede here: pass the exact id of one of your own mails`);
    if (old.from_id !== from) throw new RefusedError(`${old.id} isn't yours: only its sender may supersede a mail`);
    if (old.superseded_by) throw new RefusedError(`${old.id} is already superseded by ${old.superseded_by}`);
    if (old.permission_id) throw new RefusedError(`${old.id} is a permission request: it settles through answer_permission`);
  }
  if (input.itsa) {
    const { idOf } = await import('./itsa.ts');
    const id = await idOf(String(input.itsa));
    if (!id) throw new Error(`no ITSA ${input.itsa}`);
    input = { ...input, about_itsa: id, itsa: undefined };
  }
  if (!input.forwarded && input.body?.includes('```pane')) input = { ...input, body: capturePanes(input.body) };
  if (!input.forwarded && /```(embed|video|audio|image|file|compare)/.test(input.body ?? '')) input = { ...input, ...embedFiles(input) };
  // Answering a mail in an ITSA's thread, named or guessed, is a comment on the ITSA: the
  // home daemon adds the participants as recipients, and the sender becomes a participant.
  const asComment = async (parent: ReplyParent | undefined) => {
    if (!parent?.itsa_id || input.itsa_id || input.forwarded) return undefined;
    const { postRouted } = await import('./itsa.ts');
    // An answer to Kim's own mail reaches Kim only when it names them, like any comment: mail between
    // agents in a thread Kim started stays in the thread, out of Kim's inbox (S-542; S-308 added Kim always).
    // An agent's reply posts only where the agent may post (S-480); stam's own mail stands in as an agent and isn't checked.
    return postRouted(parent.itsa_id, { by: from!, to: input.to, inferred: input.inferred, subject: input.subject, body: input.body, attachments: input.attachments, reply_to: parent.id, override: input.override }, input.from_stam ? undefined : via);
  };
  // The mail replied to may live only on a peer (its recipient's machine, S-359). A peer's
  // forwarded copy already carries its thread, so it doesn't ask again. An agent's reply asks
  // the peer as that agent, which checks what the agent may see.
  const via: Via | undefined = from === HUMAN || from!.startsWith('system:') ? undefined : { agent: from!, boss: from === chiefOfStaff()?.id || db.getAgent(from!)?.kind === 'assistant' };
  const found = input.reply_to && !input.forwarded ? await parentOf(input.reply_to, via) : undefined;
  const replied = found?.parent;
  // An agent's reply to the human's mail reaches them only when it names them (S-542); the agent hears so.
  const hint = replied?.from_id === HUMAN && db.getAgent(from) && !input.from_stam && !input.permission_id && !input.to.includes(HUMAN) ? { misses_human: true as const } : {};
  if (input.reply_to) {
    const posted = await asComment(replied);
    if (posted) return { ...posted, ...hint };
  }
  let threadId = input.forwarded || input.itsa_id ? input.thread_id : undefined;
  if (input.reply_to && !threadId) {
    const parent = replied;
    if (found?.hidden) throw new Error(`mail ${input.reply_to} isn't visible to you (you aren't in its thread), so you can't reply to it. Start a new thread with new_thread: true, or ask whoever pointed you to it to forward that mail to you.`);
    if (!parent) throw new Error(`no mail ${input.reply_to} to reply to${found?.unreachable ? ' (a peer was unreachable)' : ''}`);
    threadId = parent.thread_id ?? parent.id;
    if (!input.subject) input = { ...input, subject: 'Re: ' + parent.subject.replace(/^(re:\s*)+/i, '') };
  }
  // Like a reply in a Slack thread, an agent's answer lands in the thread it answers,
  // whether or not the agent named it.
  if (!threadId && !input.reply_to && !input.new_thread && !input.forwarded && from !== HUMAN) {
    const parent = guessParent(from, input.to, input.subject);
    if (parent) {
      const posted = await asComment(parent);
      if (posted) return posted;
      threadId = parent.thread_id ?? parent.id;
      input = { ...input, reply_to: parent.id, subject: input.subject || 'Re: ' + parent.root_subject.replace(/^(re:\s*)+/i, ''), auto_threaded: true };
    }
  }
  if (!input.subject) throw new Error('subject is required for a new thread');

  const local = new Set<string>();
  const named = new Set<string>();
  const remote = new Map<Peer, string[]>();
  const addRemote = (p: Peer, ref: string) => remote.set(p, [...(remote.get(p) ?? []), ref]);
  // The inferred recipients a peer gets, by id, so it skips them too; and those skipped here, by name.
  const inferredIds = new Set<string>();
  const skipped: string[] = [];
  for (const ref of input.to) {
    if (ref === HUMAN) local.add(HUMAN);
    else if (ref === 'all') {
      for (const a of db.listAgents()) if (a.lifecycle !== 'archived' && !a.forwarded_to && a.id !== from) local.add(a.id);
      if (!input.forwarded) for (const p of peers()) addRemote(p, 'all');
    } else {
      const skipPeers = Boolean(input.forwarded) && !input.relay;
      const found = await resolveRecipient(ref, skipPeers);
      if (typeof found === 'object') {
        // An agent whose work moved to a successor (cost_switch) has its mail forwarded there.
        if (found.peer) {
          addRemote(found.peer, found.agent.id);
          if (inferred.has(ref)) inferredIds.add(found.agent.id);
        } else {
          local.add(db.forwardTarget(found.agent.id));
          named.add(db.forwardTarget(found.agent.id));
        }
      } else {
        // Known on a peer that doesn't answer: its mail waits in the outbox (S-235). An agent
        // no peer has, or one a peer answered 404 for, is forgotten and fails as before.
        const known = found === 'unreachable' && !input.forwarded ? db.findPeerAgent(ref) : undefined;
        // An agent known to be archived fails as it did before the outbox (S-235); it isn't queued.
        const archived = known && db.peerAgentLifecycle(known.id) === 'archived';
        const peer = known && !archived && peerByName(known.machine);
        if (!peer) {
          if (found === 'absent' && !skipPeers) db.forgetPeerAgent(ref);
          // A recipient the sender didn't name doesn't sink the mail for the rest of the thread (S-603).
          if (inferred.has(ref)) {
            skipped.push(db.findPeerAgent(ref)?.name ?? db.lastSenderName(ref) ?? ref);
            continue;
          }
          throw new RefusedError(archived ? `no agent ${ref}: ${known!.name} is archived and ${known!.machine} doesn't answer` : `no agent ${ref}`);
        }
        addRemote(peer, known!.id);
        if (inferred.has(ref)) inferredIds.add(known!.id);
      }
    }
  }
  // An ITSA comment with nobody else to tell is still a comment: it lands in the thread.
  if (!local.size && !remote.size && !input.itsa_id) throw new RefusedError(!skipped.length ? 'no recipients' : from === HUMAN ? `${skipped.join(', ')} no longer exists. Reply to someone else, or copy your text.` : `no recipients: ${skipped.join(', ')} can't get mail any more. Name someone in to.`);
  // A parent may have limited whom this agent can reach; 'all' then means everyone it may reach.
  const limits = db.getAgent(from) ? reachable(db.getAgent(from)!) : undefined;
  if (limits && input.to.includes('all')) for (const id of local) if (id !== HUMAN && !limits.has(id)) local.delete(id);
  // S-548: only the chief of staff, the assistant, and managers mail the human directly; any other
  // agent's mail to the human goes to its first parent, who forwards it if it is needed. The parent
  // may be on a peer (a storage agent's parent runs on the home daemon), so it is resolved like any recipient.
  let rerouted: string | undefined;
  const sender = db.getAgent(from);
  if (sender && local.has(HUMAN) && !input.from_stam && !input.permission_id && !input.forwarded && sender.kind !== 'assistant' && sender.id !== chiefOfStaff()?.id && sender.type !== 'manager' && sender.type !== 'coordinator') {
    const parent = db.parentsOf(sender)[0] ?? chiefOfStaff()?.id;
    const found = parent && parent !== sender.id ? await resolveRecipient(parent) : undefined;
    if (typeof found === 'object') {
      local.delete(HUMAN);
      if (found.peer) addRemote(found.peer, found.agent.id);
      else local.add(db.forwardTarget(found.agent.id));
      rerouted = found.agent.name;
      input = { ...input, body: `Meant for your user. Forward it only if they need it. Subject: ${input.subject ?? '(none)'}\n\n${input.body ?? ''}` };
    }
  }
  for (const id of [...local, ...[...remote.values()].flat()]) if (id !== 'all') checkCanMail(from, id);
  // The full suite's failure triage (S-1074) mails agents and comments on ITSAs, never the human, directly or through a thread or an
  // ITSA's participants: any shared-token caller can name it, so it is held to what it needs.
  if (NEVER_MAILS_HUMAN.has(from) && local.has(HUMAN)) throw new RefusedError(`${from} may mail agents and comment on ITSAs, not your user`);
  // Stam's own mail and permission requests still reach the human; an agent's mail to the human may be refused.
  const blocked = local.has(HUMAN) && from !== HUMAN && !input.from_stam && !input.permission_id && !input.forwarded ? await humanMailBlock(from) : undefined;
  if (blocked) throw new Error(`${blocked.name} runs ${blocked.model}, which may not mail your user (Settings › Mail to you). Mail your parent${blocked.parent ? ` (${blocked.parent})` : ''} instead; it decides what reaches your user.`);
  // S-983: the mail gate. An agent's mail that still goes to the human is checked before it is stored; stam's own
  // mail (from_stam, an ITSA ask), permission requests, the human's mail, and a peer's forwarded copy (gated where
  // it was sent) never are. An ITSA post relayed from an agent on a peer is the exception: its home daemon sends
  // it, so it is gated there and the refusal goes back to the agent through the relay.
  let gate: { verdict?: db.MailVerdict; override?: string } = {};
  const relayed = Boolean(input.forwarded && input.relay);
  if (local.has(HUMAN) && from !== HUMAN && !from.startsWith('system:') && !input.from_stam && !input.permission_id && (!input.forwarded || relayed) && input.kind !== 'ask') {
    const override = typeof input.override === 'string' ? input.override.trim().slice(0, 500) : '';
    if (override) gate = { override };
    else if (settings().decisions.mailGate && apiKey()) {
      const verdict = await gateMail(input.subject, input.body ?? '', threadId, from);
      const failed = verdict ? gateFailures(verdict) : [];
      db.addEvent(from, 'mail:gate', { subject: input.subject, ...(verdict ? { score: verdict.score, fluff: verdict.fluff, value: verdict.value } : { unchecked: true }), passed: !failed.length });
      if (failed.length) throw new RefusedError(`Not sent: the mail check says this mail to your user ${failed.join('; ')}. Fix the mail and send again, or resend with \`override: "why"\` if you disagree (\`override\` works even if your tool schema doesn't list it yet).`);
      gate = { verdict: verdict ?? undefined };
    }
  }
  const id = input.forwarded && input.mail_id ? input.mail_id : db.newMailId();
  threadId ??= id;
  // The daemon that guessed logs it; a peer re-storing a forwarded mail doesn't re-log
  // the sending agent's event (its events live where it does).
  if (input.auto_threaded && !input.forwarded) db.addEvent(from, 'mail:auto_threaded', { id, thread_id: threadId, reply_to: input.reply_to });
  let mail: db.Mail | undefined;
  if (local.size || (input.itsa_id && !remote.size)) mail = storeMail(id, threadId, from, fromName!, [...local], input, gate);
  // The sender's copy (S-241): a mail that goes to a peer is also stored here, with no local
  // recipients, so the sender's threads, reply_to, and read_thread see it while it is queued or
  // delivered. It is stored only once a destination has taken the mail (queued or accepted), so a
  // refused send leaves none. The copy is never unread for anyone and never notices anyone.
  // Forwarded mail comes from a peer's agent, whose copy the peer keeps.
  const keepCopy = () => {
    if (!mail && !input.forwarded) mail = storeMail(id, threadId, from, fromName!, [], input);
  };
  let queuedTo: string[] | undefined;
  // Mail an agent or the human sends for itself, not stam's own mail (from_stam), a permission relay, or a
  // peer's forwarded mail, may start a stopped peer (S-245), when the sender is also allowed to (mayStartPeer, S-1473).
  const direct = (from === HUMAN || Boolean(db.getAgent(from))) && !input.from_stam && !input.permission_id && !input.forwarded;
  for (const [peer, to] of remote) {
    const attachments = (input.attachments ?? []).map((a) => ({
      name: a.name ?? (a.path ? basename(a.path) : 'attachment.txt'),
      content_b64: a.content_b64 ?? (a.path ? readFileSync(a.path).toString('base64') : Buffer.from(a.content ?? '').toString('base64')),
    }));
    const payload = { ...input, from, to, inferred: to.filter((x) => inferredIds.has(x)), attachments, thread_id: threadId, mail_id: id, relay: undefined, title: undefined, summary: undefined, forwarded: { from_name: fromName } };
    // Mail to 'all' skips the peer, as it always has; mail to named agents waits in the outbox (S-235).
    const named = to.filter((x) => x !== 'all');
    const queue = () => {
      db.queueOutbox(id, peer.name, JSON.stringify({ ...payload, to: named }));
      queuedTo = [...(queuedTo ?? []), ...named];
      keepCopy();
      if (direct && startsPeer(peer, to, named)) {
        if (mayStartPeer(from, named)) startQueuedPeer(peer, fromName ?? from);
        else console.log(`peer:start ${peer.name}: not started: mail from ${fromName ?? from} to ${named.join(', ')} waits in the outbox`);
      }
    };
    // Mail already waiting for this peer goes behind it, so the peer gets mail in order.
    if (named.length && db.outboxHasPeer(peer.name)) {
      queue();
      void drainOutbox();
      continue;
    }
    let r;
    try {
      r = await peerCall(peer, 'POST', '/api/mail', payload);
    } catch {
      if (named.length) queue();
      continue;
    }
    if (r.status !== 200) {
      // The peer's 4xx is its refusal (it checked the sender or the recipient): the sender hears the reason as a 400, not a 500 (S-590).
      const msg = `${peer.name}: ${r.data?.error ?? r.status}`;
      throw r.status >= 400 && r.status < 500 ? new RefusedError(msg) : new Error(msg);
    }
    keepCopy();
    // A relayed send (forwarded, as itsa.post sends for an agent on a peer) has no copy here when
    // every recipient is remote: the peer's stored mail is what the caller gets back.
    mail ??= r.data;
  }
  // A title for scanning, asked after delivery by the daemon the mail starts on, for this copy and
  // the peers' (S-297).
  if (!input.forwarded) maybeTitleMail({ id, subject: input.subject, body: input.body ?? '' }, [...remote.keys()].map((p) => p.name), [...local, ...[...remote.values()].flat()].includes(HUMAN));
  // The system view's mail flight (S-456): the send is stored (or queued) and the sender may
  // see it. A peer re-storing a forwarded mail is a delivery, not a send, so it doesn't emit.
  if (!input.forwarded) emitSent(id, threadId, from, queuedTo ?? [...local, ...[...remote.values()].flat()], input, local.has(HUMAN));
  const stoppedAgents = [...named].map((r) => db.getAgent(r)).filter((a): a is db.Agent => Boolean(a && notRunning(a)));
  // The sender hears it in the result; the parent hears it too, since mail from the human, the CLI,
  // or an ITSA thread has no agent reading that result.
  // A burst of mail to one stopped agent tells its parent once per STOPPED_MAIL_NOTICE_MS (the notice counts the unread).
  for (const a of stoppedAgents) {
    if (Date.now() - (stoppedToldAt.get(a.id) ?? 0) < STOPPED_MAIL_NOTICE_MS) continue;
    stoppedToldAt.set(a.id, Date.now());
    tellStopped(a, `Mail ${id} from ${fromName ?? from} to ${a.name} ("${input.subject}") waits unread: ${a.name} isn't running (${a.activity_detail ?? a.lifecycle}).`, from);
  }
  const stopped = stoppedAgents.map((a) => a.name);
  const extra = { ...(stopped.length ? { not_running: stopped } : {}), ...(rerouted ? { rerouted } : {}), ...(skipped.length ? { skipped } : {}), ...hint };
  // The superseded mail's human copy is withdrawn (src/withdraw.ts), keeping the thread open for the new mail.
  if (supersededHere(input, from))
    await (await import('./withdraw.ts')).withdrawFromHuman([input.supersedes!], from, `Superseded by ${id}`, { keepThread: true, closeKept: true }).catch((e) => console.error(`supersede: ${e instanceof Error ? e.message : e}`));
  if (queuedTo) return { id, thread_id: threadId, to: queuedTo, queued: true, ...extra };
  return { ...mail!, ...extra };
}

const STOPPED_MAIL_NOTICE_MS = 10 * 60_000;
const stoppedToldAt = new Map<string, number>();

// S-384: tells a stopped agent's parent (else the chief of staff) why it stopped and how to bring it
// back, unless that parent is `except` (the sender, who hears it already).
export function tellStopped(a: db.Agent, what: string, except?: string): void {
  const parent = db.parentsOf(a)[0] ?? chiefOfStaff()?.id;
  if (!parent || parent === except || parent === a.id) return;
  const unread = db.unreadCount(a.id);
  const waiting = unread ? ` ${unread} unread mail wait for it.` : '';
  tellAnywhere(parent, `${what}${waiting} If its work should go on, resume it: agent_control resume (stam resume ${a.name}).`).catch(() => {});
}

// S-384: an agent no mail can reach until it is started again: shut down, or its harness ended
// its session (the daemon shuts it down soon after). A paused agent gets its mail on unpause.
function notRunning(a: db.Agent): boolean {
  return a.lifecycle === 'shut_down' || (a.lifecycle === 'active' && a.activity === 'unknown' && a.activity_detail === db.SESSION_ENDED);
}

// `mail.sent` for the web's event stream. `ask` is true when a mail that reaches the human
// carries an ask: an ITSA ask, or a decision block the human must answer.
function emitSent(id: string, threadId: string, from: string, to: string[], input: SendInput, toHuman: boolean): void {
  events.emitEvent('mail.sent', {
    id,
    from,
    to,
    thread: threadId,
    itsa: input.itsa_id ?? null,
    ask: toHuman && (input.kind === 'ask' || hasDecisionBlock(input.body ?? '')),
    subject: input.subject,
    at: new Date().toISOString(),
  });
}

// Direct mail queued for a stopped peer starts it (S-245). Only mail an agent or the human names
// directly, to a live recipient, starts the peer; broadcasts, stam's own mail, permission relays
// and mail to shut-down agents just wait in the outbox for the peer to come up.
// S-1473: and only from the human, the chief of staff, or an ancestor of a named recipient; a
// standing agent's routine mail (self-retro) must not wake a paid machine.
export function mayStartPeer(sender: string, named: string[]): boolean {
  if (sender === HUMAN || sender === chiefOfStaff()?.id) return true;
  const below = descendantsOf(sender);
  return named.some((id) => below.has(id));
}

function startsPeer(peer: Peer, to: string[], named: string[]): boolean {
  if (!peer.start || to.includes('all') || !named.length) return false;
  return named.some((id) => !['archived', 'shut_down'].includes(db.peerAgentLifecycle(id) ?? ''));
}

// One start per trigger: the peer's start command runs once (peers.ts ensureUp shares a run), then
// the outbox is delivered. A failed start is logged; the mail stays queued.
function startQueuedPeer(peer: Peer, sender: string): void {
  console.log(`peer:start ${peer.name}: queued mail from ${sender}`);
  ensureUp(peer)
    .then(() => drainOutbox())
    .catch((e) => console.error(`peer:start ${peer.name}: ${e instanceof Error ? e.message : e}`));
}

// Queued mail (S-235) is redelivered to its peer every STAM_OUTBOX_MS (default 30 s), oldest
// first. A peer's failure stops that peer's queue until the next pass. Rows older than seven
// days are dropped, with a mail:expired event on the sender.
const OUTBOX_EXPIRE_MS = 7 * 24 * 3600_000;
const senderOf = (body: { from?: string }) => (body.from && db.getAgent(body.from) ? body.from : undefined);
export async function deliverOutbox(): Promise<void> {
  for (const row of db.outboxExpire(new Date(Date.now() - OUTBOX_EXPIRE_MS).toISOString())) {
    const body = JSON.parse(row.body);
    const sender = senderOf(body);
    if (sender) db.addEvent(sender, 'mail:expired', { id: row.mail_id, peer: row.peer, to: body.to, last_error: row.last_error });
  }
  const stopped = new Set<string>();
  for (const row of db.outboxRows()) {
    const peer = peerByName(row.peer);
    if (!peer || stopped.has(row.peer)) continue;
    const body = JSON.parse(row.body);
    const sender = senderOf(body);
    let r;
    try {
      r = await peerCall(peer, 'POST', '/api/mail', body);
    } catch (e) {
      // A network failure: the row stays, and this peer's queue waits for the next pass.
      db.outboxFailed(row.mail_id, row.peer, e instanceof Error ? e.message : String(e));
      stopped.add(row.peer);
      continue;
    }
    if (r.status >= 500) {
      // The peer is up but not taking mail now (busy, restarting): the row stays, and this
      // peer's queue waits for the next pass.
      db.outboxFailed(row.mail_id, row.peer, `${r.data?.error ?? r.status}`);
      stopped.add(row.peer);
      continue;
    }
    db.outboxDelete(row.mail_id, row.peer);
    if (r.status !== 200) {
      // The peer refused the mail (4xx): it is dropped, so the peer's queue moves on.
      const error = `${r.data?.error ?? r.status}`;
      if (sender) {
        db.addEvent(sender, 'mail:failed', { id: row.mail_id, peer: row.peer, to: body.to, subject: body.subject, error });
        queueNotice(sender, `The mail you queued failed: ${row.mail_id} to ${(body.to ?? []).join(', ')}, subject "${body.subject}": ${error}`);
      }
      continue;
    }
    if (sender) db.addEvent(sender, 'mail:delivered_late', { id: row.mail_id, peer: row.peer, to: body.to });
  }
}

// One pass at a time. A pass asked for while another runs runs once more after it, so mail
// queued meanwhile isn't left for the next tick (S-235 review).
let pass: Promise<void> | undefined;
let again = false;
export function drainOutbox(): Promise<void> {
  if (pass) {
    again = true;
    return pass;
  }
  pass = (async () => {
    do {
      again = false;
      await deliverOutbox();
    } while (again);
  })()
    .catch((e) => console.error(`outbox: ${e instanceof Error ? e.message : e}`))
    .finally(() => (pass = undefined));
  return pass;
}

export function startOutbox(): void {
  const every = Number(process.env.STAM_OUTBOX_MS) || 30_000;
  setInterval(() => void drainOutbox(), every).unref();
}

// stam itself has no mailbox, so the first running agent stands in as the sender of mail
// stam sends on its own behalf (usage warnings, credit warnings, cost notices). The human
// sees `[stam]` in the subject; the stand-in is only the envelope.
export function stamSender(): db.Agent | undefined {
  return db.listAgents().find((a) => a.lifecycle === 'active');
}

// Mail from stam itself, with the mail it made. Undefined when no agent at all can stand in as sender.
// `from_stam` marks it, so the stand-in sender doesn't clear a declared wait for its reply.
export async function sendFromStamMail(to: string[], subject: string, body: string): Promise<SentMail | undefined> {
  // With no running agent (low memory is when agents get paused or archived), the newest agent
  // still stands in, so the mail reaches its recipients.
  const sender = stamSender() ?? db.listAgents()[0];
  if (!sender) return undefined;
  return sendMail({ from: sender.id, to, subject, body, new_thread: true, from_stam: true });
}

// Mail from stam itself. Returns false when no agent at all can stand in as sender.
export async function sendFromStam(to: string[], subject: string, body: string): Promise<boolean> {
  return (await sendFromStamMail(to, subject, body)) !== undefined;
}

// Logs the mail for each agent recipient and schedules the idle push.
function notify(id: string, from: string, subject: string, to: string[], fromStam = false): void {
  for (const r of to) {
    if (r === HUMAN) continue;
    db.addEvent(r, 'mail:received', { id, from, subject });
    schedulePush(r);
  }
  clearDeclaredWaits(id, from, to, fromStam);
}

// A wait declared with wait_for clears itself when the awaited mail arrives: for an agent
// wait, mail from that agent to this one; for a human wait, mail from the user. A wait that
// names a thread clears only for mail in that thread. Mail stam sent on its own behalf never
// clears one: its stand-in sender isn't the agent the wait is on. See src/waits.ts.
function clearDeclaredWaits(mailId: string, from: string, to: string[], fromStam: boolean): void {
  if (fromStam) return;
  const m = db.getMail(mailId);
  if (!m) return;
  const thread = m.thread_id ?? m.id;
  for (const r of to) {
    if (r === HUMAN) continue;
    for (const w of db.listWaits(r)) {
      if (w.source !== 'declared') continue;
      if (!(w.kind === 'agent' && w.target === from) && !(w.kind === 'human' && from === HUMAN)) continue;
      let data: any = {};
      try {
        data = w.data ? JSON.parse(w.data) : {};
      } catch {}
      if (data.thread) {
        const want = db.getMail(String(data.thread))?.thread_id ?? String(data.thread);
        if (m.id !== String(data.thread) && thread !== want) continue;
      }
      db.clearWait(w.id);
    }
  }
}

// Whether this daemon holds the superseded mail (S-1304): the sender's own daemon validated it before
// storing; a recipient's daemon, given the forwarded mail, applies it only to a copy it holds from that sender.
function supersededHere(input: SendInput, from: string): boolean {
  if (!input.supersedes) return false;
  if (!input.forwarded) return true;
  const old = db.getMail(String(input.supersedes));
  return !!old && old.from_id === from && !old.superseded_by;
}

function storeMail(id: string, threadId: string, from: string, fromName: string, to: string[], input: SendInput, gate: { verdict?: db.MailVerdict; override?: string } = {}): db.Mail {
  const quiet = input.itsa_id ? to.filter((r) => !input.interrupt?.includes(r)) : [];
  // The same mail arriving again (a forward under its original id) only adds recipients.
  const stored = db.getMail(id);
  if (stored) {
    if (input.forwarded && input.title && !stored.title) db.setMailTitle(id, input.title, db.PEER_TITLE_CONFIG);
    if (input.forwarded && input.summary && !stored.summary) db.setMailSummary(id, input.summary);
    const added = db.addRecipients(id, to, quiet);
    notify(id, from, input.subject ?? stored.subject, added, Boolean(input.from_stam));
    // The human pushes once per mail: only when this arrival made the human a recipient.
    if (added.includes(HUMAN)) onHumanMail({ id, thread_id: stored.thread_id ?? id, from_id: stored.from_id, from_name: stored.from_name ?? fromName, subject: stored.subject, permission_id: stored.permission_id ?? null });
    return stored;
  }
  const dir = join(STAM_HOME, 'attachments', id);
  const files: { name: string; path: string; size: number }[] = [];
  const save = (name: string, write: (p: string) => void) => {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, basename(name));
    write(p);
    files.push({ name: basename(name), path: p, size: statSync(p).size });
  };

  let body = input.body ?? '';
  if (body.length > BODY_LIMIT_CHARS) {
    save('full-body.md', (p) => writeFileSync(p, body));
    body = body.slice(0, BODY_LIMIT_CHARS) + `\n\n[stam: body truncated at about 5,000 tokens; the full text is in the attachment full-body.md]`;
  }
  for (const a of input.attachments ?? []) {
    if (a.content_b64 !== undefined) save(a.name ?? 'attachment.bin', (p) => writeFileSync(p, Buffer.from(a.content_b64!, 'base64')));
    else if (a.path) save(a.name ?? a.path, (p) => copyFileSync(a.path!, p));
    else if (a.content !== undefined) save(a.name ?? 'attachment.txt', (p) => writeFileSync(p, a.content!));
  }

  db.createMail({ id, from_id: from, from_name: fromName, subject: input.subject, body, thread_id: threadId, reply_to: input.reply_to ?? null, permission_id: input.permission_id ?? null, auto_threaded: input.auto_threaded, notice: Boolean(input.from_stam || input.system), itsa_id: input.itsa_id, kind: input.kind, health: input.health, about_itsa: input.about_itsa, verdict: gate.verdict, override: gate.override, note: humanNote(input, from) }, to, quiet);
  for (const f of files) db.addAttachment(id, f.name, f.path, f.size);
  linkMail({ id, thread_id: threadId, subject: input.subject, body: input.body, itsa_id: input.itsa_id, about_itsa: input.about_itsa });
  // Indexed for search by meaning, queued so the send never waits on the embedder (S-141).
  indexMail(id);
  notify(id, from, input.subject, to, Boolean(input.from_stam));
  // Every stored forwarded copy is a peer's: its title and summary are the peer's to make, whether or not one came (S-1843).
  if (input.forwarded) db.setMailTitleConfig(id, db.PEER_TITLE_CONFIG);
  if (input.forwarded && input.title) db.setMailTitle(id, input.title, db.PEER_TITLE_CONFIG);
  if (input.forwarded && input.summary) db.setMailSummary(id, input.summary);
  const mail: db.Mail = {
    id, from_id: from, subject: input.subject, body, created_at: new Date().toISOString(), attachments: files, thread_id: threadId,
    reply_to: input.reply_to ?? null, permission_id: input.permission_id ?? null, auto_threaded: input.auto_threaded ? 1 : 0,
    itsa_id: input.itsa_id ?? null, about_itsa: input.about_itsa ?? input.itsa_id ?? null, kind: input.kind ?? null, health: input.health ?? null,
    verdict: gate.verdict ?? null, override: gate.override ?? null,
  };
  // A decision mail waits on the human until they reply in its thread (src/decision-mail.ts).
  // A deferral (Decide later, S-353) keeps the decision listed, off the waiting list; any other reply from the human answers it.
  if (from === HUMAN) {
    if (isDeferralOnly(body, files.length)) db.setThreadDeferred(threadId, id);
    else { db.clearThreadDeferred(threadId); db.clearDecisionMails(threadId); }
  } else {
    // Only mail to the human brings a deferred ask back: a note between agents doesn't reach Kim (S-353).
    if (to.includes(HUMAN)) db.clearThreadDeferred(threadId);
    if (to.includes(HUMAN) && input.kind !== 'ask' && !input.from_stam && !input.permission_id && !/^\[stam\]/.test(input.subject ?? '') && hasDecisionBlock(body)) db.addDecisionMail(id, threadId);
  }
  if (to.includes(HUMAN)) {
    onHumanMail({ id, thread_id: threadId, from_id: from, from_name: fromName, subject: input.subject, permission_id: input.permission_id ?? null });
    // The decision model's mail check runs after delivery, off the send path; see mail-check.ts.
    maybeCheckMail(mail, Boolean(input.from_stam));
    // Decision steps (src/steps.ts) look at agents' mail, never stam's own or a permission request.
    if (from !== HUMAN && !input.from_stam && !input.permission_id) for (const fn of humanMailObservers) fn({ id, from_id: from, subject: input.subject, body, thread_id: threadId });
  }
  if (supersededHere(input, from)) {
    db.supersedeMail(input.supersedes!, id);
    db.removeDecisionMail(input.supersedes!);
  }
  // Requirement checks (src/req-check.ts) look at every stored mail, async; off unless enabled.
  maybeCheckRequirements(mail, to.includes(HUMAN), Boolean(input.from_stam));
  return mail;
}

// Observers of an agent's mail to the human, called after it is stored.
type HumanMailObserver = (m: { id: string; from_id: string; subject: string; body: string; thread_id: string }) => void;
const humanMailObservers: HumanMailObserver[] = [];
export function onMailToHuman(fn: HumanMailObserver): void {
  humanMailObservers.push(fn);
}

// `loudOnly` is the notice during a working turn, which leaves out quiet ITSA mail.
function noticeList(agentId: string, loudOnly = false): { count: number; list: string } {
  const unread = db.inbox(agentId, true, NOTICE_LIST, loudOnly);
  const count = db.unreadCount(agentId, loudOnly);
  const list = unread.map((m) => `- ${m.id} from ${m.from_name ?? senderName(m.from_id)}: ${m.subject}`).join('\n');
  return { count, list };
}

function senderName(id: string): string {
  return id === HUMAN ? 'the human' : (db.getAgent(id)?.name ?? id);
}

// System notices (for example context thresholds) wait here until the agent sees them:
// after its next tool call, or as a prompt if it's idle.
// An idle-only notice is a new task (such as a ring turn): it waits for a fresh turn
// instead of riding on some other tool's result, where a model can overlook it.
// `ring` marks a ring turn, for the admission gate's record.
const notices = new Map<string, { text: string; idleOnly: boolean; ring?: boolean }[]>();

export function queueNotice(agentId: string, text: string, opts: { idleOnly?: boolean; ring?: boolean } = {}): void {
  notices.set(agentId, [...(notices.get(agentId) ?? []), { text, idleOnly: Boolean(opts.idleOnly), ring: opts.ring }]);
  db.addEvent(agentId, 'notice:queued', { text: text.slice(0, 120) });
  schedulePush(agentId);
}

export const queuedNoticeCount = (agentId: string): number => notices.get(agentId)?.length ?? 0;

// Drops the notices queued after the first `n`: a ring that failed to start takes its turn notices back.
export function truncateNotices(agentId: string, n: number): void {
  const q = notices.get(agentId);
  if (q && q.length > n) notices.set(agentId, q.slice(0, n));
}

// Queues a notice for an agent here, or asks the daemon that has it to (its
// POST /api/agents/:id/notice). `want` checks the agent first, here or as its daemon lists
// it: a parent's child-notices mode, say. 'absent' when every daemon answered without it,
// 'unreachable' when a daemon that may have it didn't answer; a refusal throws.
export async function tellAnywhere(agentId: string, text: string, want?: (a: db.Agent) => boolean): Promise<'told' | 'absent' | 'unreachable'> {
  const local = db.getAgent(agentId);
  if (local) {
    if (!want || want(local)) queueNotice(local.id, text);
    return 'told';
  }
  const f = await locateAgent(agentId);
  if (typeof f !== 'object') return f;
  if (want && !want(f.agent)) return 'told';
  let r;
  try {
    r = await peerCall(f.peer, 'POST', `/api/agents/${encodeURIComponent(f.agent.id)}/notice`, { text });
  } catch {
    return 'unreachable';
  }
  if (r.status >= 300) throw new Error(`${f.peer.name} refused the notice: ${r.data?.error ?? r.status}`);
  return 'told';
}

// Drops a queued notice that no longer applies, such as cost_switch's wrap-up request to an
// agent whose turn ended before it saw it.
export function dropNotice(agentId: string, text: string): void {
  const kept = (notices.get(agentId) ?? []).filter((n) => n.text !== text);
  if (kept.length) notices.set(agentId, kept);
  else notices.delete(agentId);
}

function takeNotices(agentId: string, includeIdleOnly: boolean): string[] {
  const all = notices.get(agentId) ?? [];
  const taken = all.filter((n) => includeIdleOnly || !n.idleOnly);
  const kept = all.filter((n) => !taken.includes(n));
  if (kept.length) notices.set(agentId, kept);
  else notices.delete(agentId);
  return taken.map((n) => n.text);
}

// Text for a hook that runs after a tool call, or undefined when there's nothing new.
export function inTurnNotice(agentId: string): string | undefined {
  const parts = takeNotices(agentId, false);
  // ITSA comments and updates don't interrupt; they arrive with the idle batch (pushIfIdle).
  if (db.unreadCount(agentId, true)) parts.push(render('mail-notice', noticeList(agentId, true)));
  return parts.length ? parts.join('\n\n') : undefined;
}

const timers = new Map<string, NodeJS.Timeout>();

// While `fn` types into an agent's input, no prompt is pushed to it, so a pushed turn can't
// start in the middle of the typing.
const pushHolds = new Set<string>();
export async function holdingPushes<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  pushHolds.add(agentId);
  try {
    return await fn();
  } finally {
    pushHolds.delete(agentId);
  }
}

// Set by lifecycle.ts: wakes a resting standing agent (S-897). Mail and notices call
// schedulePush, so it is the one place that sees all of them.
let restWaker: ((agentId: string) => void) | null = null;
export function onRestWake(fn: (agentId: string) => void): void {
  restWaker = fn;
}

// Batches mail that arrives close together into one prompt.
export function schedulePush(agentId: string): void {
  if (restWaker && (db.unpushedCount(agentId) > 0 || queuedNoticeCount(agentId) > 0)) restWaker(agentId);
  clearTimeout(timers.get(agentId));
  timers.set(
    agentId,
    setTimeout(() => {
      timers.delete(agentId);
      pushIfIdle(agentId).catch(() => {});
    }, PUSH_DEBOUNCE_MS),
  );
}

// An idle agent makes no tool calls, so unread mail it hasn't been prompted about
// arrives as a prompt. Working agents get the notice after their next tool call instead.
// The prompt starts a turn, so it passes the admission gate: a held agent's mail and
// notices stay queued until it is let go (lifecycle.resumeNow pushes them then).
async function pushIfIdle(agentId: string): Promise<void> {
  // stam is typing into the agent's input (permissions.ts, S-422): the push waits for it.
  if (pushHolds.has(agentId)) return schedulePush(agentId);
  const a = db.getAgent(agentId);
  if (!a || (a.lifecycle !== 'active' && a.lifecycle !== 'paused')) return;
  if (a.activity !== 'idle' && a.activity !== 'waiting') return;
  const hasMail = db.unpushedCount(agentId) > 0;
  const pending = notices.get(agentId) ?? [];
  if (!hasMail && !pending.length) return;
  if (!admit(a, pending.some((n) => n.ring) ? 'ring' : 'mail').ok) return;
  const text = [...pending.map((n) => n.text), ...(hasMail ? [render('mail-prompt', noticeList(agentId))] : [])].join('\n\n');
  if (await adapters[a.harness]?.pushPrompt?.(a, text).catch(() => false)) {
    notices.delete(agentId);
    if (hasMail) db.markPushed(agentId);
    db.addEvent(agentId, 'pushed', { mail: hasMail, notices: pending.length });
  }
}
