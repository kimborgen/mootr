// Permission requests: an agent whose harness blocked something it needs asks through
// stam. A 'delegate' ask goes to the agent's parent and the chief of staff (settings.chiefOfStaff)
// only, and reaches the human when they escalate it, or when neither is live (S-432); a paused one
// isn't live (S-589). A 'human' ask goes to the human; the reviewers get a quiet notice and may deny
// it, never approve it. A harness dialog is a delegate ask whose yes is still the human's alone
// (S-520), and goes to the human when nobody answers it in time (S-589). The answer reaches the
// agent as a notice that says who answered, never dressed up as someone else.
import * as db from './db.ts';
import { render, withFailureRetro } from './templates.ts';
import { sendMail, queueNotice, holdingPushes, HUMAN } from './mail.ts';
import { admit } from './admission.ts';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testOnlyEnv } from './test-env.ts';
import { parseProviderConfig } from './llm/openai.ts';
import { bedrockBase, parseBedrockConfig } from './llm/bedrock.ts';
import { settings, REDACTED, SECRET_NAME, patchedSettingsText, patchTouchedText, writeSettingsText, fileProblem, redactSettingsText, effectiveSettingsText, isSettingsHome, splitSettingsPatch, patchLocalKeys, withLocalKeys } from './settings.ts';
import { noteInvalid } from './accounts.ts';
import { STAM_HOME } from './config.ts';
import { sharedFilesChanged } from './settings-sync.ts';
import { noteSettingsChange } from './permission-modes.ts';
import * as budgets from './budgets.ts';
import { unifiedDiff } from './textdiff.ts';
import { adapters } from './adapters/index.ts';
import { inputProblem, bashInputRecorded } from './adapters/claude-input.ts';
import { dialogQuestion } from './adapters/claude-dialog.ts';
import { withdrawFromHuman, withdrawQuietly } from './withdraw.ts';
import { askHome, NO_HOME_HINT, overrideNote, placement, postAskLink, type Home, type HomeInput } from './ask-home.ts';
import { ASK_NOTE, isPlacedAsk } from './mail-visibility.ts';
import { announceTreeIdle, syncChildrenWaits } from './org.ts';

function reviewers(a: db.Agent): string[] {
  const out = new Set<string>();
  // The parent may be on another machine (S-320).
  if (a.parent_id && (db.getAgent(a.parent_id) || db.findPeerAgent(a.parent_id))) out.add(a.parent_id);
  const cos = settings().chiefOfStaff ? db.getAgent(settings().chiefOfStaff!) : undefined;
  if (cos && cos.id !== a.id && (cos.lifecycle === 'active' || cos.lifecycle === 'paused')) out.add(cos.id);
  return [...out];
}

// Reviewers that can decide now: a local one is active; one on another machine, unless it is known
// to be paused, archived or gone. A paused agent takes no turns, so an ask sent to it would wait
// unseen (S-589): it goes to the next in line, and with none to the human. A paused reviewer may
// still answer what reached it before (reviewers).
function liveReviewers(a: db.Agent): string[] {
  return reviewers(a).filter((id) => {
    const x = db.getAgent(id);
    // A peer-machine reviewer is live unless its last known lifecycle says otherwise.
    const life = x ? x.lifecycle : db.peerAgentLifecycle(id);
    return life === undefined || life === 'active';
  });
}

// The fence is longer than any run of backticks in the text, so the text can't close it and render as markdown.
const fenced = (details: string, lang = '') => {
  if (!details) return '';
  const fence = '`'.repeat(Math.max(3, ...(details.match(/`+/g) ?? []).map((f) => f.length + 1)));
  return fence + lang + '\n' + details + '\n' + fence;
};
// A harness dialog's request carries the hook's JSON as its details. The mail says in a line what the
// agent wants, shows the command or target in a block that wraps, and says who has looked (S-520): `told`
// are the parent and chief of staff it goes to first, who deny or escalate it (`next` tells them how);
// an escalated one names who sent it on and why, and a timed-out one (`timedOut`, in minutes) who
// it waited on (S-589); 0 minutes means stam sends dialogs on without waiting.
export function dialogMail(requester: string, told: string[], action: string, details: string, fallbackWhy: string, route: { id?: string; escalator?: string; reason?: string; timedOut?: number } = {}): { line: string; shown: string; why: string; seen: string; subject: string; next: string } {
  let tool = action.replace(/^Claude Code asks to allow /, ''), input: Record<string, any> = {};
  const names = told.map((id) => db.getAgent(id)?.name ?? db.findPeerAgent(id)?.name).filter(Boolean);
  const tagged = names.map((n) => '@' + n).join(' and ');
  const seen = route.escalator
    ? `@${route.escalator} looked first and sent it on to you: ${route.reason}`
    : route.timedOut !== undefined
      ? `It went to ${tagged || 'its parent and the chief of staff'} first, and ${timedOutWhy(route.timedOut)}, so it comes to you.`
      : names.length ? `It came to ${tagged} first; the human hasn't seen it. Nobody has decided yet.` : 'Nobody else has seen it.';
  const next = names.length && !route.escalator && route.timedOut === undefined
    ? `_Answer with \`answer_permission\` and id \`${route.id}\`: deny it, with a note on what ${requester} does instead, or escalate it to the human with a one-line reason when ${requester} needs it and only a yes unblocks it. Only the human approves a dialog. Never leave it waiting: ${requester} is blocked until someone answers._`
    : '';
  try { const j = JSON.parse(details); if (j && typeof j === 'object') { tool = typeof j.tool === 'string' ? j.tool : tool; input = j.input && typeof j.input === 'object' ? j.input : {}; } } catch { return { line: `wants an answer to this dialog: ${action}`, shown: fenced(details), why: fallbackWhy, seen, subject: `Permission: ${action}`, next }; }
  const target = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : typeof input.url === 'string' ? input.url : typeof input.pattern === 'string' ? input.pattern : '';
  // A question dialog shows its question and options, numbered as the choice is typed (S-3978).
  const q = tool === 'AskUserQuestion' ? dialogQuestion(input) : undefined;
  const line = q ? 'asks a question, with these options.' : tool === 'Bash' ? 'wants to run a shell command.' : target ? `wants to use ${tool} with this input.` : `wants to use ${tool}.`;
  const shown = q ? fenced([q.question, '', ...q.options.map((o, i) => `${i + 1}. ${o}`)].join('\n')) : target ? fenced(target, 'bash') : fenced(JSON.stringify(input, null, 2), 'json');
  const why = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : "The harness gave no reason with this dialog; ask the agent, or read its last message in its terminal.";
  // The subject says what is happening, so the mail list reads without opening the mail.
  const subject = q ? `${requester} asks: ${q.question.replace(/\s+/g, ' ')}` : `${requester} ${tool === 'Bash' && target ? 'wants to run' : 'asks to use ' + tool}${target ? ': ' + target.replace(/\s+/g, ' ') : ''}`;
  return { line, shown, why, seen, subject: subject.length > 90 ? subject.slice(0, 89) + '…' : subject, next };
}
const DELEGATE_WAIT = 'your parent or the chief of staff';
// Why a dialog went on to the human by itself, after settings.dialogEscalateMinutes.
const timedOutWhy = (n: number) => (n > 0 ? `nobody answered within ${n} minute${n === 1 ? '' : 's'}` : "stam's settings send dialogs on without waiting for an answer");

// Why a request can't be sent, or null when it can (S-3203): a blank action reached the human as an
// empty ask. `toHuman` is whether the request reaches the human, which a delegate ask does when nobody
// can decide it. Every caller of POST /api/permissions and requestPermission goes through this first, so
// a refused request stores no row, sends no mail and makes no notice.
export function askRefusal(action: unknown, reason: unknown, toHuman: boolean): string | null {
  if (!String(action ?? '').trim()) return 'request_permission: `action` is required (what you need to do, in one line; put the exact command in `details`)';
  if (toHuman && !String(reason ?? '').trim()) return 'request_permission: `reason` is required when the request reaches your user (why only your user\'s consent unblocks it)';
  return null;
}

// askRefusal for this agent's ask, routed as requestPermission routes it: a delegate ask with a live reviewer
// goes to that reviewer, and anything else reaches the human.
export function refusalFor(a: db.Agent, action: unknown, reason: unknown, audience: unknown, payload = false): string | null {
  const delegate = audience === 'delegate' && !payload && liveReviewers(a).length > 0;
  return askRefusal(action, reason, !delegate);
}

// A settings change is always the human's; so is a delegate ask nobody can decide. A delegated
// harness dialog lets the reviewers deny or escalate it, never approve it (answerDialog).
// `extra.home` names the ask's home thread (ask-home.ts, S-3827): an ask that reaches the human joins it, and one
// without a home is refused before anything is stored. `extra.tool` names the tool in that refusal.
// The result carries `hint` when the ask found no home, telling the agent how to name one next time.
// Test seam (S-3979): awaited after an ask's row exists and before its mail is stored, so a test can close the request in that window.
export const askMailHold: { before?: () => Promise<void> } = {};

export async function requestPermission(a: db.Agent, action: string, reason: string, details: string, dialog = false, extra: { payload?: string; fence?: string; home?: HomeInput; tool?: string } = {}, audience: db.PermissionRequest['audience'] = 'human'): Promise<Omit<db.PermissionRequest, 'payload'> & { hint?: string }> {
  const refused = refusalFor(a, action, reason, audience, !!extra.payload);
  if (refused) throw new Error(refused);
  const live = liveReviewers(a);
  const delegate = audience === 'delegate' && !extra.payload && live.length > 0;
  const noDelegate = audience === 'delegate' && !delegate && !dialog && !extra.payload;
  // A harness dialog names no home: one that goes straight to the human finds the agent's ITSA, or a new thread.
  const home = await askHome(a, extra.home ?? {}, delegate ? 'delegate' : dialog ? 'fallback' : 'human', extra.tool);
  const r = db.createPermissionRequest(a.id, action, reason, details, dialog, extra.payload ?? null, delegate ? 'delegate' : 'human');
  db.setRequestHome(r.id, { thread: home.thread, itsa: home.itsa?.id, override: home.override });
  // A pending request is one wait on the agent, keyed by the request. It makes the agent busy, so
  // its parents wait on it too. The human's is a 'human' wait; a delegate ask waits on the reviewers.
  if (delegate) db.addWait({ agent_id: a.id, kind: 'agent', target: live[0], detail: DELEGATE_WAIT, source: 'stam', data: r.id });
  else db.addWait({ agent_id: a.id, kind: 'human', target: r.id, detail: 'your approval', source: 'stam' });
  syncChildrenWaits(a.id);
  // The request travels as a mail, in its home thread when it goes to the human; the web UI shows Approve and Deny on it.
  const why = noDelegate ? `_${a.name} has no parent or chief of staff to decide, so this comes to you._\n\n` : '';
  const footer = delegate
    ? `_You decide this: answer with \`answer_permission\` and id \`${r.id}\`, with decision approve, deny or escalate (escalate it to the human, with a one-line reason, when only the human can decide). Never leave it waiting: ${a.name} is blocked until someone answers._`
    : `_The human decides this. ${live.length ? 'Reviewing agents may only deny it' : 'Only the human approves'}: deny with \`answer_permission\` and id \`${r.id}\` if it must not happen._`;
  const d = dialog ? dialogMail(a.name, delegate ? live : [], action, details, reason, { id: r.id }) : undefined;
  const body = d ? render('permission-dialog', { requester: a.name, ...d, id: r.id }) : render('permission-request', { requester: a.name, action, reason, details: fenced(details, extra.fence), id: r.id, why, footer });
  await askMailHold.before?.();
  // A delegate ask keeps its own thread with the reviewers (S-3827 leaves it as it was).
  const sent = await sendMail({ from: a.id, to: delegate ? live : [HUMAN], subject: (d?.subject ?? `Permission: ${action}`).slice(0, 200), body: delegate ? body : overrideNote(home) + body, permission_id: r.id, ...(delegate ? { new_thread: true as const } : placement(home)) });
  // Closed while its mail was being stored (S-3979): the mail is withdrawn at once, as the close would have pulled it had it been there.
  if (db.getPermissionRequest(r.id)?.status !== 'pending') pullAsk(r.id, 'stam', 'Withdrawn: closed while it was being sent');
  else if (!delegate) await postAskLink(a, home, sent.id, action);
  // A paused reviewer hears of a human ask too, when it next takes a turn.
  if (!delegate) for (const id of reviewers(a)) if (db.getAgent(id)) queueNotice(id, render('permission-human-notice', { requester: a.name, action, id: r.id }));
  db.addEvent(a.id, 'permission:requested', { id: r.id, action, audience: r.audience });
  return { ...db.publicRequest(db.getPermissionRequest(r.id)!), ...(home.noHome ? { hint: NO_HOME_HINT } : {}) };
}

// A reviewer sends a delegate ask to the human (S-432): the audience changes, the human gets a mail that
// stands alone, and the requester is told. `reason` is the reviewer's one line.
export async function escalatePermission(id: string, by: string, reason: string, peer?: { boss: boolean }): Promise<Omit<db.PermissionRequest, 'payload'>> {
  const { r, a, name } = reviewer(id, by, peer);
  if (r.audience !== 'delegate') throw new Error(`request ${id} is already with the human`);
  const why = reason.replace(/\s+/g, ' ').trim();
  if (!why) throw new Error('say why you escalate it: a one-line reason is required');
  if (!db.escalatePermissionRequest(id)) throw new Error(`request ${id} is already with the human`);
  const d = r.dialog ? dialogMail(a.name, [], r.action, r.details, r.reason, { escalator: name, reason: why }) : undefined;
  const body = d ? render('permission-dialog', { requester: a.name, ...d, id }) : render('permission-escalated', { requester: a.name, action: r.action, reason: r.reason, details: fenced(r.details), id, escalator: name, why });
  await handToHuman(r, a, d?.subject ?? `Permission: ${r.action}`, body, name, why);
  db.addEvent(a.id, 'permission:escalated', { id, by, why });
  return db.publicRequest(db.getPermissionRequest(id)!);
}

// The ask is the human's now (escalatePermissionRequest moved it): the requester waits on the human,
// the human gets one mail that stands alone, in the requester's home thread (S-3827: the thread or ITSA the ask
// named, else the requester's ITSA, else a new thread), and the requester hears who sent it on and why.
async function handToHuman(r: db.PermissionRequest, a: db.Agent, subject: string, body: string, escalator: string, why: string): Promise<void> {
  db.clearRequestWaits(a.id, r.id);
  db.addWait({ agent_id: a.id, kind: 'human', target: r.id, detail: 'your approval', source: 'stam' });
  syncChildrenWaits(a.id);
  // The stored home thread was checked when the ask was made, and is a thread id (an ITSA's has no mail of that id), so it
  // isn't looked up again; askHome still finds the ITSA, for the link line.
  const found = await askHome(a, { itsa: r.home_itsa, override: r.home_override }, 'fallback');
  const home = r.home_thread ? { ...found, thread: r.home_thread, override: null, noHome: false } : found;
  db.setRequestHome(r.id, { thread: home.thread, itsa: home.itsa?.id, override: home.override });
  const sent = await sendMail({ from: a.id, to: [HUMAN], subject: subject.slice(0, 200), body: overrideNote(home) + body, permission_id: r.id, ...placement(home) });
  await postAskLink(a, home, sent.id, r.action);
  queueNotice(a.id, render('permission-escalation-notice', { id: r.id, action: r.action, escalator, why }));
}

// Pulls a settled or withdrawn ask's mail from the human (withdraw.ts). An ask placed in its home thread (S-3827)
// leaves that thread open: it holds the work's other mail, which the ask's settling doesn't answer. Whether it was
// placed is read from this daemon's copy of its mail; a mail missing here, of a request that has a home thread, counts
// as placed, so a miss keeps the thread open and never archives a home thread.
function pullAsk(id: string, by: string, note: string): void {
  const ids = db.permissionMailIds(id);
  const homed = !!db.getPermissionRequest(id)?.home_thread;
  const placed = ids.some((m) => {
    const x = db.getMail(m);
    return x ? isPlacedAsk(x) : homed;
  });
  if (!placed) return withdrawQuietly(ids, by, note);
  withdrawFromHuman(ids, by, note, { keepThread: true, closeKept: true }).catch((e) => console.error(`withdraw: ${note}: ${e instanceof Error ? e.message : e}`));
}

// A harness dialog with the parent and the chief of staff that none of them answered within
// settings.dialogEscalateMinutes goes to the human (S-589), in the same dialog mail, naming who it
// went to. The daemon runs this every few seconds. The move to the human is one conditional
// UPDATE, so a reviewer's escalation or answer never races it into a second mail or a late one.
// A dialog whose agent was shut down or archived (quitHarness runs no hook) is withdrawn instead:
// nothing is on screen to answer.
export async function escalateStaleDialogs(): Promise<void> {
  const limit = settings().dialogEscalateMinutes;
  const cutoff = new Date(Date.now() - limit * 60_000).toISOString();
  for (const r of db.pendingDialogs()) {
    const a = db.getAgent(r.agent_id);
    if (!a) continue;
    if (a.lifecycle !== 'active' && a.lifecycle !== 'paused') {
      withdrawDialog(a, r, `${a.name} is ${a.lifecycle.replace('_', ' ')}`);
      continue;
    }
    if (r.audience !== 'delegate' || r.created_at > cutoff || !db.escalatePermissionRequest(r.id)) continue;
    const waited = db.permissionMailRecipients(r.id);
    const why = timedOutWhy(limit);
    try {
      const d = dialogMail(a.name, waited, r.action, r.details, r.reason, { timedOut: limit });
      await handToHuman(r, a, d.subject, render('permission-dialog', { requester: a.name, ...d, id: r.id }), 'stam', why);
    } catch (e) {
      db.addEvent(a.id, 'permission-error', String(e));
    }
    db.addEvent(a.id, 'permission:escalated', { id: r.id, by: 'stam', why, waited });
  }
}

// Harness dialogs: a prompt the harness shows in the agent's terminal, such as Claude Code's
// "Allow this read outside the working directories?", blocks the agent until someone answers
// it there, and the agent itself can't. The adapter's hooks report it; stam makes it a
// permission request like request_permission's, one per dialog, and types the answer in.
// It goes to the agent's parent and the chief of staff first (S-520): they deny it, so the agent
// carries on another way, or escalate it to the human when only a yes unblocks it. With neither
// live it goes straight to the human.
// A hook that names its dialog (`replaces`) withdraws a pending request for another one; the
// same dialog reported again, after a daemon restart say, keeps its request.
export async function dialogShown(a: db.Agent, action: string, details: string, replaces = false): Promise<void> {
  const pending = db.pendingDialog(a.id);
  if (pending && (!replaces || (pending.action === action && pending.details === details))) return;
  if (pending) withdrawDialog(a, pending, 'a newer dialog replaced it');
  await requestPermission(a, action, 'its harness shows a dialog that blocks it', details, true, {}, 'delegate');
}

// The agent moved on (a hook says it isn't blocked any more): a dialog answered in the
// terminal, or gone with its turn, needs no answer through stam.
export function dialogClosed(a: db.Agent): void {
  const r = db.pendingDialog(a.id);
  if (r) withdrawDialog(a, r, 'closed outside stam');
}

// S-2885: closes the agent's requests pending since `before` or earlier, ask mails and waits included, as an
// answered one is. Returns how many.
export function withdrawStaleRequests(a: db.Agent, before: string, note: string): number {
  const stale = db.stalePendingPermissions(a.id, before);
  for (const r of stale) withdrawDialog(a, r, note);
  return stale.length;
}

// A suggestion that is still pending when its agent stops, is archived or is forgotten can't be answered for
// anything: it is withdrawn, its ask pulled from the human's inbox, its waits cleared (S-3830).
export function withdrawPendingInputs(a: db.Agent, note: string): void {
  for (const r of db.inputRequests('pending', a.id)) {
    if (!db.moveInputRequest(r.id, 'pending', 'withdrawn', { note })) continue;
    db.addEvent(a.id, 'permission:withdrawn', { id: r.id, note });
    pullAsk(r.id, 'stam', `Withdrawn: ${note}`);
    settle(a, r.id);
  }
}

function withdrawDialog(a: db.Agent, r: db.PermissionRequest, note: string): void {
  db.withdrawPermissionRequest(r.id, note);
  pullAsk(r.id, 'stam', `Withdrawn: ${note}`);
  db.addEvent(a.id, 'permission:withdrawn', { id: r.id, note });
  // Its own try: a failed clear leaves the wait, but the withdrawal and the other requests still go on (S-3016).
  try {
    db.clearRequestWaits(a.id, r.id);
  } catch (e) {
    console.error(`withdraw ${r.id}: couldn't clear its waits: ${e instanceof Error ? e.message : e}`);
    db.addEvent(a.id, 'permission:wait-clear-failed', { id: r.id, error: String(e) });
  }
  syncChildrenWaits(a.id);
  announceTreeIdle(a);
}

// `by` is an agent id, or 'human'. Agents may answer only for their children, or as chief of staff or the assistant.
// `peer` marks an agent on another machine whose daemon forwarded the answer, and says whether
// that daemon vouches for it as its chief of staff or assistant (S-320).
export async function answerPermission(id: string, approve: boolean, by: string, note: string, peer?: { boss: boolean }): Promise<Omit<db.PermissionRequest, 'payload'> & { typed?: boolean }> {
  const delegate = db.getPermissionRequest(id)?.audience === 'delegate';
  const out = await answer(id, approve, by, note, peer);
  // Someone else settled it: the human's mail about it is pulled (S-413). Their own answer stays theirs to read.
  // A delegate ask never reached the human, so there is nothing to pull.
  if (by !== HUMAN && !delegate) pullAsk(id, by, `Answered by @${db.getAgent(by)?.name ?? db.findPeerAgent(by)?.name ?? by}: ${approve ? 'approved' : 'denied'}`);
  return out;
}

// The pending request, its agent, and whether `by` may answer for it; throws otherwise.
function checked(id: string, by: string, peer?: { boss: boolean }) {
  const r = db.getPermissionRequest(id);
  if (!r) throw new Error(`no permission request ${id}`);
  if (r.status !== 'pending') throw new Error(`request ${id} is already ${r.status}`);
  const a = db.getAgent(r.agent_id);
  if (!a) throw new Error(`the requesting agent is gone, so request ${id} is closed`);
  const assistant = by !== HUMAN && db.getAgent(by)?.kind === 'assistant';
  const boss = !!peer?.boss && by !== a.parent_id;
  if (by !== HUMAN && !assistant && !boss && !(peer && by === a.parent_id) && !reviewers(a).includes(by)) throw new Error(`${by} can't answer for ${a.name}; only the human, the assistant, its parent, or the chief of staff can`);
  return { r, a, assistant, boss };
}

// A reviewing agent (not the human) and its name, for escalating.
function reviewer(id: string, by: string, peer?: { boss: boolean }) {
  if (by === HUMAN) throw new Error('the human decides it; escalating is for reviewing agents');
  const c = checked(id, by, peer);
  return { ...c, name: db.getAgent(by)?.name ?? db.findPeerAgent(by)?.name ?? by };
}

// The line typed into an agent when the human approves: it names the request and says the action is
// approved, so the agent doesn't resend the request (S-640). It starts with "I authorize" for auto mode,
// which takes only typed input as the user's consent. A note other than the default is appended.
export function approvedTyped(id: string, action: string, note: string): string {
  const kept = note.trim().replace(/[\s.!]+$/, '');
  const short = action.length > 200 ? `${action.slice(0, 200)}…` : action;
  return render('permission-typed', { id, action: short, note: kept && kept.toLowerCase() !== 'i authorize' ? ` The user's note: ${kept}.` : '' });
}

// The human's comment on an answer (S-3829): the note, unless it is the default a bare Approve or Deny sends.
export function commentOf(note: string): string {
  const kept = note.trim();
  return kept && kept.toLowerCase() !== 'i authorize' && kept !== 'Denied' ? kept : '';
}

// The closing line of the notice an agent gets when its request is answered (S-640): approved says go
// ahead, denied says don't do it, so neither reads as a request to try again.
export function answeredNext(approve: boolean): string {
  return approve ? 'Go ahead; don\'t request it again.' : 'Don\'t do it; continue without it.';
}

async function answer(id: string, approve: boolean, by: string, note: string, peer?: { boss: boolean }): Promise<Omit<db.PermissionRequest, 'payload'> & { typed?: boolean }> {
  const { r, a, assistant, boss } = checked(id, by, peer);
  const text = note || (approve ? 'I authorize' : 'Denied');
  const name = db.getAgent(by)?.name ?? db.findPeerAgent(by)?.name ?? by;
  const who = by === HUMAN ? 'your user (the human), in stam' : `${name}, ${assistant ? "your user's executive assistant" : by === a.parent_id ? 'your parent agent' : boss ? 'the chief of staff agent on another machine' : 'the chief of staff agent'}`;
  // A question dialog's choice is the note: the option the human picked. Empty when none was given.
  if (r.dialog) return await answerDialog(r, a, approve, by, text, who, note || undefined);
  if (r.kind === 'input') return denyInput(r, a, approve, by, text, who);
  if (r.payload) return answerSettings(r, a, approve, by, text, who);
  if (approve && by !== HUMAN && r.audience === 'human') throw new Error(`request ${id} is the human's to approve: leave it to the human, or deny it if it must not happen`);
  // A deny is a failure the agent should record a retro about; an approval is not (S-726).
  const notice = render('permission-answered', { id, action: r.action, verdict: approve ? 'approved' : 'denied', who, note: text, next: answeredNext(approve) });
  const noticeText = approve ? notice : withFailureRetro(notice);
  // The decision and its notice's row commit together (S-3923): no answer exists without its row.
  const row = db.transaction(() => {
    db.decidePermissionRequest(id, approve, by, text);
    return db.addAnswerNotice(a.id, noticeText);
  });
  // The human's approval is typed into the agent's input when that's safe, since auto mode
  // takes only typed input as the user's consent. Agents' answers stay notices.
  let typed = false;
  // Typed input starts a turn: the human's own, so a held agent gets it with a cost:override event.
  if (approve && by === HUMAN) {
    admit(a, 'human');
    typed = (await adapters[a.harness]?.typeHumanInput?.(a, approvedTyped(id, r.action, note))) ?? false;
  }
  if (typed) {
    if (row) db.deleteAnswerNotice(row);
  } else {
    queueNotice(a.id, noticeText, { row: row || undefined });
  }
  db.addEvent(a.id, 'permission:answered', { id, approve, by, typed });
  // The answered request's human wait clears, so the agent may go idle, and an ancestor's
  // children wait releases with it.
  db.clearRequestWaits(a.id, id);
  syncChildrenWaits(a.id);
  // The unresolved request no longer holds this agent's subtree busy, so an ancestor's
  // deferred tree-idle notice may now be owed.
  announceTreeIdle(a);
  return { ...db.publicRequest(db.getPermissionRequest(id)!), typed };
}

// A harness dialog's answer is a key typed into it: only the human's approval is a yes,
// since a yes typed there is the user's consent; anyone reviewing can deny it, so the agent
// carries on without the action. A dialog no longer on screen, or in an ended session,
// closes the request instead; a yes that can't be tied to the request's dialog types nothing.
// A harness that answers over its API (OpenCode) throws when the answer fails, and the request stays pending.
async function answerDialog(r: db.PermissionRequest, a: db.Agent, approve: boolean, by: string, text: string, who: string, choice?: string): Promise<Omit<db.PermissionRequest, 'payload'> & { typed?: boolean }> {
  if (approve && by !== HUMAN) throw new Error(`only the human approves a harness dialog; deny it so ${a.name} carries on without it, or ${r.audience === 'delegate' ? 'escalate it to the human with a one-line reason' : 'leave it to the human'}`);
  const done = (await adapters[a.harness]?.answerDialog?.(db.getAgent(a.id)!, r, approve, choice)) ?? 'gone';
  if (done === 'unsafe') throw new Error(`${a.name}'s dialog on screen doesn't show exactly this request's action or question with the answer given, so nothing was typed; deny it, or answer it in the terminal`);
  if (done === 'gone') {
    withdrawDialog(a, r, 'no dialog on screen');
    throw new Error(`${a.name} no longer shows this dialog, so request ${r.id} is closed and nothing was typed`);
  }
  // A bare approval says nothing more than the key typed; one with a comment says it in the same notice (S-3829).
  const noticeText = !approve
    ? withFailureRetro(render('permission-answered', { id: r.id, action: r.action, verdict: 'denied', who, note: text, next: answeredNext(false) }))
    : commentOf(text) ? render('permission-answered', { id: r.id, action: r.action, verdict: 'approved', who, note: text, next: answeredNext(true) }) : undefined;
  // The decision and its notice's row commit together (S-3923).
  const row = db.transaction(() => {
    db.decidePermissionRequest(r.id, approve, by, text);
    return noticeText ? db.addAnswerNotice(a.id, noticeText) : 0;
  });
  db.addEvent(a.id, 'permission:answered', { id: r.id, approve, by, typed: true });
  db.clearRequestWaits(a.id, r.id);
  // Claude Code reads Esc as an interrupt, which runs no hook: the agent is idle now, and the
  // notice saying why starts its next turn. A harness that carries on sends a hook that says so.
  if (!approve) db.updateAgent(a.id, { activity: 'idle', activity_detail: 'dialog denied' });
  if (noticeText) queueNotice(a.id, noticeText, { row: row || undefined });
  syncChildrenWaits(a.id);
  announceTreeIdle(a);
  return { ...db.publicRequest(db.getPermissionRequest(r.id)!), typed: true };
}

// Settings changes by the chief of staff or the assistant (S-362). They don't write the file: the
// route asks the human, with a diff of the settings as they would become. The human's approval
// applies it exactly as the human's own save does, unless a value it touches changed since the ask
// (a whole-file save: unless the file did).
export type SettingsChange = { kind: 'post'; text: string } | { kind: 'patch'; patch: Record<string, unknown>; fill: boolean } | { kind: 'registry'; text: string };
interface SettingsPayload {
  change: SettingsChange;
  baseHash: string;
  // A patch's hash over the values it touches (S-974); absent on a request made before it.
  touchedHash?: string;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

// What an ask keeps of the settings it was shown against: the whole file's hash, and for a patch the
// hash of the values it touches (S-974).
export function settingsPayload(change: SettingsChange, current: string): SettingsPayload {
  return { change, baseHash: hash(current), ...(change.kind === 'patch' ? { touchedHash: hash(patchTouchedText(current, change.patch)) } : {}) };
}

// Whether the change still stands for what the human was shown: a patch needs only the values it
// touches unchanged, a whole-file save needs the whole file unchanged (S-974). A file that doesn't
// parse to an object reads as empty, so only the whole-file check can tell it apart from a real one.
export function settingsUnchangedSince(payload: Pick<SettingsPayload, 'change' | 'baseHash' | 'touchedHash'>, current: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(current);
  } catch {}
  const isObject = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  if (payload.change.kind === 'patch' && payload.touchedHash !== undefined && isObject) return hash(patchTouchedText(current, payload.change.patch)) === payload.touchedHash;
  return hash(current) === payload.baseHash;
}

// The element of the current array that a new array's element stands for: the same `name`, else the
// same `url`. An element with neither (or a plain value) has no identity, so nothing matches and a
// marker inside it is refused: restoring by position would hand one entry another's secret.
function matchElement(el: any, curArray: any): any {
  if (!Array.isArray(curArray) || !el || typeof el !== 'object') return undefined;
  for (const key of ['name', 'url']) if (typeof el[key] === 'string') return curArray.find((c) => c && typeof c === 'object' && c[key] === el[key]);
  return undefined;
}

// Agents read the settings with every secret as REDACTED, so a whole file posted back holds that
// marker where a secret was. Each marker takes the current file's value at the same path; a marker
// where the file has no value is refused rather than saved as the secret.
// A secret stays only with the destination it was for: inside an object whose url, command or args
// differ from the current one, a marker is refused, and so is one in an array element that more than
// one new element stands for.
const DESTINATION = ['url', 'command', 'args'];
const destinationMoved = (next: any, cur: any): boolean => DESTINATION.some((k) => JSON.stringify(next?.[k]) !== JSON.stringify(cur?.[k]));
function restoreRedacted(next: any, cur: any, path: string, moved = false): any {
  if (next === REDACTED) {
    if (cur === undefined || moved) throw new Error(`${path || 'the settings'} holds "${REDACTED}" ${moved ? 'under a changed url or command' : 'where the settings have no value'}; send the real value, or keep the url`);
    return cur;
  }
  if (Array.isArray(next)) {
    const uses = new Map<any, number>();
    for (const v of next) {
      const m = matchElement(v, cur);
      if (m) uses.set(m, (uses.get(m) ?? 0) + 1);
    }
    return next.map((v, i) => {
      const m = matchElement(v, cur);
      return restoreRedacted(v, m && uses.get(m) === 1 ? m : undefined, `${path}[${i}]`, moved);
    });
  }
  if (next && typeof next === 'object') {
    const here = moved || (cur && typeof cur === 'object' ? destinationMoved(next, cur) : false);
    return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, restoreRedacted(v, cur && typeof cur === 'object' ? cur[k] : undefined, path ? `${path}.${k}` : k, here)]));
  }
  return next;
}

// Where a secret differs from the current file's, the diff says so instead of showing two [redacted].
function markChangedSecrets(redactedNew: any, rawNew: any, rawCur: any, moved = false): any {
  if (redactedNew === REDACTED) return moved || rawNew !== rawCur ? `${REDACTED.slice(0, -1)}: changed]` : REDACTED;
  if (Array.isArray(redactedNew)) return redactedNew.map((v, i) => markChangedSecrets(v, rawNew?.[i], matchElement(rawNew?.[i], rawCur), moved));
  if (redactedNew && typeof redactedNew === 'object') return Object.fromEntries(Object.entries(redactedNew).map(([k, v]) => [k, markChangedSecrets(v, rawNew?.[k], rawCur?.[k], moved || (rawCur && typeof rawCur === 'object' && !Array.isArray(rawCur) && destinationMoved(rawNew, rawCur)))]));
  return redactedNew;
}
function redactedForDiff(current: string, next: string): string {
  const out = markChangedSecrets(JSON.parse(redactSettingsText(next)), JSON.parse(next), (() => { try { return JSON.parse(current); } catch { return {}; } })());
  return JSON.stringify(out, null, 2) + '\n';
}

// The change an agent sent, with each redacted value it kept put back from `current` (its GET is
// redacted), so a non-home daemon can tell which keys it really changes (S-398). Throws where a
// redacted value can't be put back, as resultOf refuses it.
export function unredactedChange(change: SettingsChange, current: string): Record<string, unknown> {
  let cur: any = {};
  try {
    cur = JSON.parse(current);
  } catch {}
  if (change.kind !== 'patch') return restoreRedacted(JSON.parse(change.text), cur, '');
  return Object.fromEntries(Object.entries(change.patch).map(([k, v]) => [k, restoreRedacted(v, cur?.[k], k)]));
}

// The user registry (STAM_HOME/registry.json) as the daemon reads it for the config page; absent is the empty override file.
const registryFile = () => join(STAM_HOME, 'registry.json');
const EMPTY_REGISTRY = '{\n  "presets": {},\n  "models": {},\n  "harnesses": {}\n}\n';
const currentRegistryText = () => (existsSync(registryFile()) ? readFileSync(registryFile(), 'utf8') : EMPTY_REGISTRY);

// The text the change makes of `current`, or the reason it is refused (the human's routes refuse the same).
function resultOf(change: SettingsChange, current: string): { text: string } | { error: string } {
  let text: string;
  if (change.kind === 'registry') {
    try {
      const p = JSON.parse(change.text);
      if (!p || typeof p !== 'object' || Array.isArray(p)) return { error: 'the registry must be a JSON object' };
    } catch (e) {
      return { error: `not valid JSON: ${e instanceof Error ? e.message : e}` };
    }
    return { text: change.text };
  }
  if (change.kind === 'patch') {
    const r = patchedSettingsText(current, change.patch, change.fill);
    if ('problem' in r) {
      if (r.field === 'cost') noteInvalid(r.problem);
      return { error: `${r.field} config rejected: ${r.problem}` };
    }
    text = r.text;
  } else {
    text = change.text;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `not valid JSON: ${e instanceof Error ? e.message : e}` };
  }
  let cur: any = {};
  try {
    cur = JSON.parse(current);
  } catch {}
  try {
    const restored = restoreRedacted(parsed, cur, '');
    if (JSON.stringify(restored) !== JSON.stringify(parsed)) {
      parsed = restored;
      text = JSON.stringify(parsed, null, 2) + '\n';
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const problem = fileProblem(parsed);
  if (problem) {
    if (problem.field === 'cost') noteInvalid(problem.problem);
    return { error: `${problem.field} config rejected: ${problem.problem}` };
  }
  return { text };
}

// Where each provider in a settings value sends its key (S-2115): the provider, the key's source (a
// stored secret, an environment variable, or a Bedrock provider's AWS credentials), and the origin. An agent that pairs a key with an origin of
// its choosing would have stam send the key there, so a change that adds or moves one is spelled out.
// The destination is read by kind, as the adapters read it (src/llm/openai.ts, src/llm/bedrock.ts); an unknown kind's raw
// fields are shown, so nothing is left out. Every name is checked before it is quoted: the line is
// Markdown, and a name with a backtick or `**` in it could change what it says.
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const quote = (x: string, ok: RegExp, otherwise: string) => (ok.test(x) ? `\`${x}\`` : otherwise);
function destinationOf(p: any): [shown: string, raw: string] {
  const cfg = parseProviderConfig(p);
  const br = cfg ? null : parseBedrockConfig(p);
  const raw = cfg ? (cfg.kind === 'azure' ? cfg.endpoint : cfg.baseUrl) : br ? bedrockBase(br) : p?.kind === 'azure' ? p.endpoint : p?.kind === 'bedrock' ? (p.endpoint ?? (typeof p.region === 'string' ? `https://bedrock-runtime.${p.region}.amazonaws.com` : undefined)) : (p?.baseUrl ?? p?.endpoint);
  if (typeof raw !== 'string' || !raw.trim()) return ['an unset address', ''];
  try {
    const u = new URL(raw);
    if (u.origin !== 'null' && /^[a-z0-9.:/\[\]-]+$/i.test(u.origin)) return [`\`${u.origin}\``, u.origin];
  } catch {}
  return ['an address that is not a URL', raw];
}
const hasKeyRef = (ref: any) => (typeof ref?.secret === 'string' && ref.secret) || (typeof ref?.env === 'string' && ref.env);
// `sig` is the raw provider, key and destination, so two names shown alike are still told apart.
export function keyDestinations(s: any): { provider: string; key: string; to: string; sig: string }[] {
  const out: { provider: string; key: string; to: string; sig: string }[] = [];
  const providers = s?.providers && typeof s.providers === 'object' ? s.providers : {};
  for (const [id, p] of Object.entries<any>(providers)) {
    // A `providers.openrouter` entry never replaces the built-in adapter (sync() in src/llm), so its key goes nowhere.
    if (id === 'openrouter') continue;
    const ref = p?.apiKey;
    const keys: [string, string][] = [
      ...(typeof ref?.secret === 'string' && ref.secret ? [[`secret:${ref.secret}`, SECRET_NAME.test(ref.secret) ? `the stored secret \`${ref.secret}\`` : 'a stored value'] as [string, string]] : []),
      ...(typeof ref?.env === 'string' && ref.env ? [[`env:${ref.env}`, `the environment variable ${quote(ref.env, ENV_NAME, 'with an unusual name')}`] as [string, string]] : []),
      // Bedrock with no apiKey signs with the AWS credentials from the chain (S-2117): those go there instead.
      ...(p?.kind === 'bedrock' && !hasKeyRef(ref) ? [[`aws:${typeof p.profile === 'string' ? p.profile : ''}`, typeof p.profile === 'string' && p.profile ? `the AWS credentials of profile ${quote(p.profile, PLAIN, 'with an unusual name')}` : 'the AWS credentials'] as [string, string]] : []),
    ];
    if (!keys.length) continue;
    const [to, dest] = destinationOf(p);
    for (const [raw, key] of keys) out.push({ provider: quote(id, PLAIN, 'with an unusual name'), key, to, sig: JSON.stringify([id, raw, dest]) });
  }
  return out;
}

// The lines that name each key a change would newly send to an origin (S-2115).
export function keyDestinationNotes(current: string, next: string): string {
  const parse = (t: string) => {
    try {
      return JSON.parse(t);
    } catch {
      return {};
    }
  };
  const before = new Set(keyDestinations(parse(current)).map((d) => d.sig));
  const added = keyDestinations(parse(next)).filter((d) => !before.has(d.sig));
  return added.map((d) => `\n\nKey destination: provider ${d.provider} would send ${d.key} to ${d.to}.`).join('');
}

// Validates the change and asks the human. Returns the request, or the reason the change is invalid (a 400).
export async function requestSettingsChange(a: db.Agent, change: SettingsChange, home: HomeInput = {}): Promise<{ request: Omit<db.PermissionRequest, 'payload'> & { hint?: string } } | { error: string }> {
  if (change.kind === 'registry') {
    const current = currentRegistryText();
    const r = resultOf(change, current);
    if ('error' in r) return r;
    const diff = unifiedDiff(current, r.text, 'registry now', 'registry if approved') || 'No visible change.';
    const payload: SettingsPayload = { change, baseHash: hash(current) };
    const request = await requestPermission(a, 'Change stam registry', `${a.name} wants to change stam's registry (STAM_HOME/registry.json)`, diff, false, { payload: JSON.stringify(payload), fence: 'diff', home, tool: 'settings_ask' });
    return { request };
  }
  // On a non-home daemon the diff is against the settings it uses (S-398); the route has refused an
  // ask that touches a shared key.
  const current = effectiveSettingsText();
  const r = resultOf(change, current);
  if ('error' in r) return r;
  // A non-home daemon writes only the change's local keys, so the diff shows only those.
  const next = isSettingsHome() ? r.text : withLocalKeys(current, splitSettingsPatch(unredactedChange(change, current), change.kind === 'patch' && change.fill).local);
  // Secrets are redacted on both sides, so the mail never carries one.
  const diff = unifiedDiff(redactSettingsText(current), redactedForDiff(current, next), 'settings now', 'settings if approved') || 'No visible change (only redacted values differ, or none).';
  const payload = settingsPayload(change, current);
  const request = await requestPermission(a, 'Change stam settings', `${a.name} wants to change stam's settings (secrets hidden in the diff below)${keyDestinationNotes(current, next)}`, diff, false, { payload: JSON.stringify(payload), fence: 'diff', home, tool: 'settings_ask' });
  return { request };
}

// A settings request is answered here: only the human approves; anyone who may answer can deny.
function answerSettings(r: db.PermissionRequest, a: db.Agent, approve: boolean, by: string, text: string, who: string): Omit<db.PermissionRequest, 'payload'> {
  if (approve && by !== HUMAN) throw new Error(`only the human approves a change to stam's settings; deny it, or leave it to the human`);
  let result = approve ? 'approved and applied' : 'denied';
  let applied = false;
  if (approve) {
    const payload = JSON.parse(r.payload!) as SettingsPayload;
    const { change, baseHash } = payload;
    if (change.kind === 'registry') {
      const current = currentRegistryText();
      if (!isSettingsHome()) result = `approved, but not applied: the registry lives on ${settings().home}; change it there`;
      else if (hash(current) !== baseHash) result = 'approved, but not applied: the registry changed after you asked, so read it again and ask again';
      else {
        writeFileSync(registryFile(), change.text);
        sharedFilesChanged();
        applied = true;
      }
      return finishSettings(r, a, applied, result, by, text, who);
    }
    const current = effectiveSettingsText();
    const next = settingsUnchangedSince(payload, current) ? resultOf(change, current) : undefined;
    // A non-home daemon splits the change itself, as its route did when the agent asked.
    const split = next && !('error' in next) && !isSettingsHome() ? splitSettingsPatch(unredactedChange(change, current), change.kind === 'patch' && change.fill) : undefined;
    if (!next) result = 'approved, but not applied: a setting it changes changed after you asked, so read the settings again and ask again';
    else if ('error' in next) result = `approved, but not applied: ${next.error}`;
    else if (split && Object.keys(split.shared).length) result = `approved, but not applied: shared settings live on ${settings().home}; change them there`;
    else if (split) {
      // A non-home daemon writes only its local keys (S-398).
      patchLocalKeys(split.local);
      applied = true;
    } else {
      const before = settings().permissionModes;
      writeSettingsText(next.text);
      noteSettingsChange(before, `${a.name}, approved by ${by}`);
      void budgets.evaluateAll();
      applied = true;
    }
  }
  return finishSettings(r, a, applied, result, by, text, who);
}

function finishSettings(r: db.PermissionRequest, a: db.Agent, applied: boolean, result: string, by: string, text: string, who: string): Omit<db.PermissionRequest, 'payload'> {
  // An approval that wasn't applied is recorded as denied, so the list never says a change happened that didn't.
  db.decidePermissionRequest(r.id, applied, by, text);
  queueNotice(a.id, render('permission-settings', { id: r.id, result, who, note: text }));
  db.addEvent(a.id, 'permission:answered', { id: r.id, approve: applied, by, typed: false });
  db.clearRequestWaits(a.id, r.id);
  syncChildrenWaits(a.id);
  announceTreeIdle(a);
  return db.publicRequest(db.getPermissionRequest(r.id)!);
}

// Suggested harness input (S-422): an agent proposes the exact line to type into its own Claude
// Code input, such as `! git status`. The human approves it, through the web UI as trustedHuman
// proves it (the daemon's route checks that; nothing here takes `by` as proof), and stam types it
// in as written. Anyone who may answer a permission request can deny it.
// An approval waits for a clear box for this long, then expires with its end told in its thread (S-3830). A suggestion
// has no TTL: it waits until the human answers it, the agent withdraws it, or the agent ends.
export const INPUT_TTL_MS = 30 * 60_000;
const approvalExpiry = () => new Date(Date.now() + INPUT_TTL_MS).toISOString();
const ago = (iso: string | null) => !!iso && iso <= new Date().toISOString();
// How long a held approval waits before the 5 s sweep types it again after a box that didn't show the text (S-3830).
const MISMATCH_RETRY_MS = 60_000;
// A test home may shorten the wait (STAM_TEST_MISMATCH_RETRY_MS), so the sweep's retry is tested without a minute.
const mismatchRetryMs = () => Number(testOnlyEnv('STAM_TEST_MISMATCH_RETRY_MS')) || MISMATCH_RETRY_MS;
// A fence longer than any run of backticks in the text, so the text shows exactly as written.
const fencedExact = (text: string) => {
  const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((f) => f.length + 1)));
  return `${fence}\n${text}\n${fence}`;
};
const inputText = (r: db.PermissionRequest, result: string) => render('input-answered', { id: r.id, result });
// An input answer's notice, durable (S-3923). `stored` is the text the row keeps, when it must differ: a draft's text
// never goes into a row.
const inputNotice = (a: db.Agent, r: db.PermissionRequest, result: string, stored?: string) => {
  const text = inputText(r, result);
  queueNotice(a.id, text, { row: db.addAnswerNotice(a.id, stored === undefined ? text : inputText(r, stored)) || undefined });
};
// A held approval's move and its notice commit in one transaction (S-3923): the move happens only with its row. False
// when the move didn't happen.
function moveInputNotice(a: db.Agent, r: db.PermissionRequest, move: () => boolean, result: string): boolean {
  const text = inputText(r, result);
  const row = db.transaction(() => (move() ? db.addAnswerNotice(a.id, text) : null));
  if (row === null) return false;
  queueNotice(a.id, text, { row: row || undefined });
  return true;
}

export async function suggestInput(a: db.Agent, text: string, reason: string, homeInput: HomeInput = {}): Promise<db.PublicRequest & { hint?: string }> {
  if (a.harness !== 'claude') throw new Error(`suggest_input types into a Claude Code input box only; ${a.name} runs ${a.harness}, whose input stam can't type into this way. Use request_permission instead`);
  const problem = inputProblem(text);
  if (problem) throw new Error(problem);
  // An unreadable named home is refused before an earlier suggestion is replaced (S-3827).
  const home: Home = await askHome(a, homeInput, 'human', 'suggest_input');
  // A new suggestion replaces the agent's earlier unanswered one. An approved one is never withdrawn by a newer
  // suggestion: it waits, in order, to be typed (S-3830).
  for (const old of db.inputRequests('pending', a.id)) {
    if (db.moveInputRequest(old.id, 'pending', 'withdrawn', { note: 'a newer suggestion replaced it' })) {
      db.addEvent(a.id, 'permission:withdrawn', { id: old.id, note: 'a newer suggestion replaced it' });
      pullAsk(old.id, 'stam', 'Withdrawn: a newer suggestion replaced it');
      db.clearRequestWaits(a.id, old.id);
    }
  }
  const sha256 = hash(text);
  const r = db.createPermissionRequest(a.id, 'Type suggested input', reason, '', false, null, 'human', { text, sha256, expires_at: null });
  db.setRequestHome(r.id, { thread: home.thread, itsa: home.itsa?.id, override: home.override });
  db.addWait({ agent_id: a.id, kind: 'human', target: r.id, detail: 'your approval', source: 'stam' });
  syncChildrenWaits(a.id);
  const pub = db.publicRequest(db.getPermissionRequest(r.id)!);
  const body = render('permission-input', { requester: a.name, machine: pub.machine, reason: reason || '(none given)', text: fencedExact(text), id: r.id });
  const sent = await sendMail({ from: a.id, to: [HUMAN, ...reviewers(a)], subject: `Input for ${a.name}: ${text}`.slice(0, 200), body: overrideNote(home) + body, permission_id: r.id, ...placement(home) });
  await postAskLink(a, home, sent.id, `Type suggested input: ${text}`);
  db.addEvent(a.id, 'permission:requested', { id: r.id, action: r.action, kind: 'input' });
  return { ...pub, ...(home.noHome ? { hint: NO_HOME_HINT } : {}) };
}

// A denial types nothing. An approval never comes this way: only approveInput, called by the
// route once trustedHuman holds, approves a suggestion.
function denyInput(r: db.PermissionRequest, a: db.Agent, approve: boolean, by: string, text: string, who: string): db.PublicRequest {
  if (approve) throw new Error(`only the human approves suggested input, from stam's web UI on ${db.publicRequest(r).machine}; deny it, or leave it to the human`);
  const noticeText = withFailureRetro(render('permission-answered', { id: r.id, action: r.action, verdict: 'denied', who, note: text, next: answeredNext(false) }));
  // The denial and its notice's row commit together (S-3923).
  const row = db.transaction(() => (db.moveInputRequest(r.id, 'pending', 'denied', { by, note: text }) ? db.addAnswerNotice(a.id, noticeText) : null));
  if (row === null) throw new Error(`request ${r.id} is already ${db.getPermissionRequest(r.id)?.status}`);
  queueNotice(a.id, noticeText, { row: row || undefined });
  db.addEvent(a.id, 'permission:answered', { id: r.id, approve: false, by, typed: false });
  settle(a, r.id);
  return db.publicRequest(db.getPermissionRequest(r.id)!);
}

function settle(a: db.Agent, id: string): void {
  db.clearRequestWaits(a.id, id);
  syncChildrenWaits(a.id);
  announceTreeIdle(a);
}

export class InputRefused extends Error {}

// The human's approval. The caller has proven the human (trustedHuman). `sha256` must be the
// stored text's, so the human approves the text they saw; the move out of pending is one
// conditional UPDATE, so a replay, a second click, or a race with the expiry finds nothing. The
// approval holds for the agent's harness session as it is now, and is typed into no other.
export async function approveInput(id: string, sha256: unknown): Promise<db.PublicRequest & { typed: boolean; outcome: Outcome; why?: string }> {
  const r = db.getPermissionRequest(id);
  if (!r || r.kind !== 'input') throw new InputRefused(`no input suggestion ${id}`);
  const a = db.getAgent(r.agent_id);
  if (!a) throw new InputRefused(`the agent that suggested ${id} is gone`);
  // A second tap on a held approval is a state, not an error (S-524): it answers with the request
  // as it is, and tries typing again. A replay of an approval already typed is still refused.
  if (r.status === 'held' && r.sha256 === sha256) {
    if (ago(r.expires_at)) {
      expireInputs();
      throw new InputRefused(`request ${id} expired at ${r.expires_at}`);
    }
    heldWhy.delete(id);
    const outcome = await tryHeld(a.id, id);
    return { ...db.publicRequest(db.getPermissionRequest(id)!), typed: outcome === 'typed', outcome, ...(outcome === 'held' && heldWhy.has(id) ? { why: heldWhy.get(id) } : {}) };
  }
  if (r.status !== 'pending') throw new InputRefused(`request ${id} is already ${r.status}`);
  if (typeof sha256 !== 'string' || sha256 !== r.sha256) throw new InputRefused(`text_sha256 doesn't match request ${id}'s text; reload it and approve what it shows`);
  if (!db.moveInputRequest(id, 'pending', 'held', { by: HUMAN, note: 'approved', session: a.session_id ?? '', expires: approvalExpiry() })) throw new InputRefused(`request ${id} is already ${db.getPermissionRequest(id)?.status}`);
  db.addEvent(a.id, 'permission:answered', { id, approve: true, by: HUMAN, kind: 'input' });
  settle(a, id);
  heldWhy.delete(id);
  const outcome = await tryHeld(a.id, id, true);
  return { ...db.publicRequest(db.getPermissionRequest(id)!), typed: outcome === 'typed', outcome, ...(outcome === 'held' && heldWhy.has(id) ? { why: heldWhy.get(id) } : {}) };
}

// Types the agent's first held approval, the oldest, so approvals go in the order the human gave them. `id` is the
// approval the caller asked about: its outcome is 'held' while an earlier one waits (why: queued). `first` is set
// when the human's approval is the call, so a busy agent is told to end its turn (held).
async function tryHeld(agentId: string, id: string, first = false): Promise<Outcome> {
  const head = db.inputRequests('held', agentId)[0];
  if (!head) return 'held';
  if (head.id === id) return typeHeld(head, first);
  const r = db.getPermissionRequest(id);
  if (r?.status === 'held') held(db.getAgent(agentId)!, r, true, 'queued');
  return 'held';
}

type Outcome = 'typed' | 'held' | 'failed' | 'cancelled' | 'expired';

// Tests hold the typing right before Enter (S-422): with STAM_TEST_INPUT_BARRIER set to a folder
// holding a `hold` file, it writes `at` there and waits until `hold` is gone. Only in a test home (src/test-env.ts).
async function testBarrier(): Promise<void> {
  const dir = testOnlyEnv('STAM_TEST_INPUT_BARRIER');
  if (!dir || !existsSync(join(dir, 'hold'))) return;
  writeFileSync(join(dir, 'at'), '');
  for (let i = 0; i < 600 && existsSync(join(dir, 'hold')); i++) await new Promise((res) => setTimeout(res, 100));
}

// The prompt each typed suggestion should submit, checked at the agent's next UserPromptSubmit.
const submitted = new Map<string, { r: db.PermissionRequest; until: number }>();
const EXPECT_MS = 60_000;
// Claude Code appends a bash-mode command's record only when the command finishes (S-3188: a ~80 s
// install showed 82 s after Enter), so the transcript check waits well past a typed prompt's bound.
export const BASH_EXPECT_MS = 15 * 60_000;

// Types a held approval into its own agent's input, at most one at a time per agent. 'held' when
// the box isn't free yet: the agent is busy, shows a dialog, or someone's draft is in it. Right
// before Enter, one conditional UPDATE moves it from held to approved only if it is still held
// and not expired, and the agent's session is still the approved one; else what was typed is
// erased ('cancelled'), so an approval that expired mid-typing is never sent.
const typing = new Set<string>();
async function typeHeld(r: db.PermissionRequest, first = false): Promise<Outcome> {
  const a = db.getAgent(r.agent_id);
  const type = a && adapters[a.harness]?.typeLiteralInput;
  if (!a || !type || typing.has(a.id)) return 'held';
  typing.add(a.id);
  try {
    // Still held, by the same text, and not expired: an expiry or a newer suggestion may have come.
    const now = db.getPermissionRequest(r.id);
    if (now?.status !== 'held' || now.sha256 !== r.sha256 || ago(now.expires_at)) return 'held';
    const sameSession = () => (db.getAgent(a.id)?.session_id ?? '') === now.session_id;
    if (!sameSession()) {
      expireHeld(a, now, 'its harness session changed after you approved it');
      return 'expired';
    }
    if (a.activity !== 'idle' && a.activity !== 'waiting') return held(a, now, first, 'busy');
    // Typed input starts a turn, the human's own: a held agent gets it with a cost:override event,
    // and one taken over by another agent gets none.
    const admitted = admit(a, 'human');
    if (!admitted.ok) {
      if (moveInputNotice(a, r, () => db.moveInputRequest(r.id, 'held', 'failed', { note: `not typed: ${admitted.reason}` }), `was approved, but stam didn't type it: ${admitted.reason}.`)) {
        noteOutcome(a, r, 'failed', `stam didn't type it: ${admitted.reason}.`);
      }
      return 'failed';
    }
    // The transcript's size right before Enter: a bash-mode command is looked for after it.
    let offset = 0;
    // The box is read again here, right before Enter (stillTyped): a key typed since the adapter's check is never sent.
    const proceed = async (stillTyped: () => boolean) => {
      await testBarrier();
      if (!stillTyped()) return false;
      offset = transcriptSize(a);
      return sameSession() && db.moveInputRequest(r.id, 'held', 'approved', { unexpired: true });
    };
    const done = await holdingPushes(a.id, () => type(a, now.text!, proceed));
    if (done === 'typed') {
      // Claude Code runs no UserPromptSubmit for a bash-mode command (2.1.296): its transcript shows it
      // instead. A slash command runs none either, and isn't checked.
      if (now.text!.startsWith('!')) void checkTranscript(a, now, offset);
      else if (!now.text!.startsWith('/')) submitted.set(a.id, { r: now, until: Date.now() + EXPECT_MS });
      heldWhy.delete(r.id);
      db.addEvent(a.id, 'input:typed', { id: r.id });
      forgetHeld(r.id);
      inputNotice(a, r, 'was approved by your user (the human) and typed into your input as written.');
      noteOutcome(a, r, 'typed', 'sent to its input exactly as approved.');
      return 'typed';
    }
    if (done === 'cancelled') {
      db.addEvent(a.id, 'input:cancelled', { id: r.id, status: db.getPermissionRequest(r.id)?.status });
      // Still held means only the session changed under it.
      if (db.getPermissionRequest(r.id)?.status === 'held') expireHeld(a, now, 'its harness session changed while stam typed it');
      return 'cancelled';
    }
    // The box didn't show exactly the text, so nothing was sent and what stam typed is erased (or left, when the
    // erase found other text in the box). The approval stays held and is typed once the box is clear (S-3830).
    if (done === 'failed') {
      db.addEvent(a.id, 'input:failed', { id: r.id });
      held(a, now, first, 'mismatch');
      return 'held';
    }
    // An erase that found the screen not as typed is 'failed' even when cancelled; the request moved on.
    if (db.getPermissionRequest(r.id)?.status !== 'held') return 'cancelled';
    return held(a, now, first, done);
  } finally {
    typing.delete(a.id);
  }
}

// Requests whose blocking draft the agent and the chief of staff were told about, once each (S-524).
const draftTold = new Set<string>();

const heldWhy = new Map<string, string>();

function held(a: db.Agent, r: db.PermissionRequest, first: boolean, why: string): 'held' {
  heldWhy.set(r.id, why);
  // The card names the text in the box while it blocks (S-534), and drops it when something else does.
  db.setHeldBox(r.id, why === 'draft' ? (adapters[a.harness]?.inputText?.(a) ?? '').slice(0, 200) : null);
  if (why === 'queued') return 'held';
  if (why === 'mismatch') {
    // Typed and erased again by the next try: the sweep waits MISMATCH_RETRY_MS before it tries again.
    retryAt.set(r.id, Date.now() + mismatchRetryMs());
    if (!mismatchTold.has(r.id)) {
      mismatchTold.add(r.id);
      db.addEvent(a.id, 'input:held', { id: r.id, why });
      inputNotice(a, r, `was approved by your user (the human), but after typing it your input box didn't show exactly the text with nothing under it, so stam erased what it typed and sent nothing. It stays approved: stam types it once your input box is clear, until ${r.expires_at}.`);
    }
  } else if (why === 'draft') {
    // Whenever a draft first blocks the input, also after a busy start: the agent is told what to clear, and the chief of staff why.
    if (draftTold.has(r.id)) return 'held';
    draftTold.add(r.id);
    const box = adapters[a.harness]?.inputText?.(a);
    db.addEvent(a.id, 'input:held', { id: r.id, why, ...(box !== undefined ? { box: box.slice(0, 200) } : {}) });
    const shown = box === undefined ? 'text' : `\`${box.slice(0, 200).replace(/`/g, "'")}\``;
    // The draft's text is the agent's to see now, and never stored: the row keeps the notice with the draft left out.
    const draftNotice = (box: string) => `was approved by your user (the human), but stam can't type it: your input box holds ${box}, which stam didn't type. Clear your input box (Ctrl+U) and stam types it at once; until ${r.expires_at}.`;
    inputNotice(a, r, draftNotice(shown), draftNotice('(a draft, not stored)'));
    const cos = settings().chiefOfStaff;
    if (cos && cos !== a.id) sendMail({ from: a.id, to: [cos], subject: `Approved input for ${a.name} is held by text in its box`, body: `Your user approved input ${r.id} for @${a.name}, but its input box holds ${shown}, which stam didn't type. stam told the agent to clear it; the approval expires at ${r.expires_at}.`, from_stam: true }).catch((e) => db.addEvent(a.id, 'permission-error', String(e)));
  } else if (first) {
    db.addEvent(a.id, 'input:held', { id: r.id, why });
    inputNotice(a, r, `was approved by your user (the human). End your turn so stam can type it into your input; you continue after. stam types it as soon as you are idle with an empty box, until ${r.expires_at}.`);
  }
  return 'held';
}

const mismatchTold = new Set<string>();
// Per held approval, the time before which the sweep doesn't try it again (MISMATCH_RETRY_MS).
const retryAt = new Map<string, number>();
// An approval that is typed or expires keeps none of its bookkeeping.
function forgetHeld(id: string): void {
  mismatchTold.delete(id);
  retryAt.delete(id);
}

// A held approval that won't be typed: the agent hears, and the human is told once in its thread.
function expireHeld(a: db.Agent, r: db.PermissionRequest, why: string): void {
  if (!moveInputNotice(a, r, () => db.moveInputRequest(r.id, 'held', 'expired', { note: why }), `expired: ${why}, so nothing was typed.`)) return;
  forgetHeld(r.id);
  db.addEvent(a.id, 'input:expired', { id: r.id, was: 'held', why });
  tellHuman(a, r, `[stam] Approved input for ${a.name} expired untyped`, render('input-expired-human', { requester: a.name, id: r.id, why }));
}

// One line in the request's thread, for the end states the human needs: typed or failed. Held and withdrawn
// aren't noted (busy is normal; a withdrawal already closes the ask), and expiry is told by expireHeld (S-3830).
// The note is sealed under a placed ask, as tellHuman makes it.
function noteOutcome(a: db.Agent, r: db.PermissionRequest, outcome: 'typed' | 'failed', line: string): void {
  tellHuman(a, r, `[stam] Input for ${a.name}: ${outcome}`, `${outcome[0].toUpperCase()}${outcome.slice(1)}: ${line}`);
}

// Under an ask placed in its home thread (S-3827) the note is sealed like the ask (ASK_NOTE): the thread's other readers
// never saw the ask, and the note may quote the agent's prompt.
function tellHuman(a: db.Agent, r: db.PermissionRequest, subject: string, body: string): void {
  const m = db.permissionMail(r.id);
  const kind = m && isPlacedAsk({ ...m, permission_id: r.id }) ? ASK_NOTE : undefined;
  sendMail({ from: a.id, to: [HUMAN], subject, body, reply_to: m?.id, from_stam: true, kind }).catch((e) => db.addEvent(a.id, 'permission-error', String(e)));
}

// The agent's harness took a prompt (its UserPromptSubmit hook): the first one after a typed
// suggestion must be that suggestion's text; if it isn't, the human is told once.
export function promptSubmitted(agentId: string, prompt: string): void {
  const e = submitted.get(agentId);
  if (!e) return;
  submitted.delete(agentId);
  if (Date.now() > e.until) return;
  const text = e.r.text ?? '';
  const matched = prompt.trim() === text.trim() || (text.startsWith('!') && prompt.trim() === text.slice(1).trim());
  db.addEvent(agentId, 'input:submitted', { id: e.r.id, matched, prompt: prompt.slice(0, 200) });
  if (matched) return;
  const a = db.getAgent(agentId);
  if (!a) return;
  db.addEvent(a.id, 'input:mismatch', { id: e.r.id, prompt: prompt.slice(0, 2000) });
  tellHuman(a, e.r, `[stam] Input for ${a.name} submitted something else`, render('input-mismatch-human', { requester: a.name, id: e.r.id, prompt: fencedExact(prompt.slice(0, 2000)) }));
}

const transcriptSize = (a: db.Agent): number => {
  try {
    const file = db.getAgent(a.id)?.transcript_path;
    return file ? statSync(file).size : 0;
  } catch {
    return 0;
  }
};

// Where a poll left off in a transcript: the next byte to read, and a last row still being written.
export type RowTail = { pos: number; carry: Buffer };

// The whole rows appended to `file` since the last call (from tail.pos), so a poll reads only new
// bytes, never the whole transcript. A last row without its newline waits in tail.carry for the next call.
export function tailRows(file: string, tail: RowTail): string {
  const size = statSync(file).size;
  if (size < tail.pos) {
    tail.pos = size;
    tail.carry = Buffer.alloc(0);
  }
  if (size > tail.pos) {
    const buf = Buffer.alloc(size - tail.pos);
    const fd = openSync(file, 'r');
    try {
      const n = readSync(fd, buf, 0, buf.length, tail.pos);
      tail.carry = Buffer.concat([tail.carry, buf.subarray(0, n)]);
      tail.pos += n;
    } finally {
      closeSync(fd);
    }
  }
  const end = tail.carry.lastIndexOf(10) + 1;
  const rows = tail.carry.subarray(0, end).toString('utf8');
  tail.carry = tail.carry.subarray(end);
  return rows;
}

// A typed bash-mode command must show in the agent's transcript within BASH_EXPECT_MS (bashInputRecorded).
// Only what was appended after Enter counts (from `offset`), since the agent's own suggest_input
// call earlier in the transcript holds the text too. If another command shows first, or none does,
// the human is told once.
async function checkTranscript(a: db.Agent, r: db.PermissionRequest, offset: number): Promise<void> {
  const tail: RowTail = { pos: offset, carry: Buffer.alloc(0) };
  for (const until = Date.now() + BASH_EXPECT_MS; Date.now() < until; await new Promise((res) => setTimeout(res, 1000))) {
    const file = db.getAgent(a.id)?.transcript_path;
    try {
      const rows = file ? tailRows(file, tail) : '';
      const seen = rows ? bashInputRecorded(rows, r.text!) : 'none';
      if (seen === 'match') {
        db.addEvent(a.id, 'input:submitted', { id: r.id, matched: true, prompt: r.text!.slice(0, 200), via: 'transcript' });
        return;
      }
      if (seen === 'other') break;
    } catch {}
  }
  db.addEvent(a.id, 'input:mismatch', { id: r.id, via: 'transcript' });
  tellHuman(a, r, `[stam] Input for ${a.name} submitted something else`, render('input-mismatch-human', { requester: a.name, id: r.id, prompt: fencedExact('(the command is not in its transcript)') }));
}

// The agent went idle or waiting (a hook): its held approval, if any, is typed now. The pane
// may still be drawing the box, so it tries a few times; the sweep below tries again later. A box
// that didn't show the text waits for the sweep's MISMATCH_RETRY_MS, so it isn't retried here (S-3830).
export async function typeHeldInput(agentId: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const r = db.inputRequests('held', agentId)[0];
    if (!r || (await typeHeld(r)) !== 'held') return;
    if ((retryAt.get(r.id) ?? 0) > Date.now()) return;
    await new Promise((res) => setTimeout(res, 300));
  }
}

// Every few seconds: an approval past its TTL expires (the human is told once, in its thread, and nothing is
// typed), and held ones whose agent is idle are tried again. A suggestion has no TTL (S-3830).
export function expireInputs(): void {
  for (const r of db.inputRequests('held')) {
    const a = db.getAgent(r.agent_id);
    if (ago(r.expires_at) && a) expireHeld(a, r, `it expired at ${r.expires_at} before the input box was free`);
    // The agent went busy: the box text the card showed is stale, and a restart would cut a turn.
    else if (a && a.activity !== 'idle' && a.activity !== 'waiting' && r.note?.startsWith('box:')) db.setHeldBox(r.id, null);
  }
}

// The sweep: each agent's oldest held approval is tried again while the agent is idle or waiting, after a
// mismatch's wait. Approvals of one agent are typed one at a time, in order.
export async function retryHeldInputs(): Promise<void> {
  expireInputs();
  const heads = new Map<string, db.PermissionRequest>();
  for (const r of db.inputRequests('held')) if (!heads.has(r.agent_id)) heads.set(r.agent_id, r);
  for (const r of heads.values()) {
    const a = db.getAgent(r.agent_id);
    if (a && (a.activity === 'idle' || a.activity === 'waiting') && (retryAt.get(r.id) ?? 0) <= Date.now()) await typeHeld(r).catch((e) => db.addEvent(r.agent_id, 'permission-error', String(e)));
  }
}
