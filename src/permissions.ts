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
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testOnlyEnv } from './test-env.ts';
import { settings, REDACTED, patchedSettingsText, patchTouchedText, writeSettingsText, costProblem, redactSettingsText, effectiveSettingsText, isSettingsHome, splitSettingsPatch, patchLocalKeys, withLocalKeys } from './settings.ts';
import { noteInvalid } from './accounts.ts';
import { STAM_HOME } from './config.ts';
import { sharedFilesChanged } from './settings-sync.ts';
import * as budgets from './budgets.ts';
import { unifiedDiff } from './textdiff.ts';
import { adapters } from './adapters/index.ts';
import { inputProblem, bashInputRecorded } from './adapters/claude-input.ts';
import { withdrawQuietly } from './withdraw.ts';
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
  const line = tool === 'Bash' ? 'wants to run a shell command.' : target ? `wants to use ${tool} with this input.` : `wants to use ${tool}.`;
  const shown = target ? fenced(target, 'bash') : fenced(JSON.stringify(input, null, 2), 'json');
  const why = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : "Claude Code gave no reason with this dialog; ask the agent, or read its last message in its terminal.";
  // The subject says what is happening, so the mail list reads without opening the mail.
  const subject = `${requester} ${tool === 'Bash' && target ? 'wants to run' : 'asks to use ' + tool}${target ? ': ' + target.replace(/\s+/g, ' ') : ''}`;
  return { line, shown, why, seen, subject: subject.length > 90 ? subject.slice(0, 89) + '…' : subject, next };
}
const DELEGATE_WAIT = 'your parent or the chief of staff';
// Why a dialog went on to the human by itself, after settings.dialogEscalateMinutes.
const timedOutWhy = (n: number) => (n > 0 ? `nobody answered within ${n} minute${n === 1 ? '' : 's'}` : "stam's settings send dialogs on without waiting for an answer");

// A settings change is always the human's; so is a delegate ask nobody can decide. A delegated
// harness dialog lets the reviewers deny or escalate it, never approve it (answerDialog).
export async function requestPermission(a: db.Agent, action: string, reason: string, details: string, dialog = false, extra: { payload?: string; fence?: string } = {}, audience: db.PermissionRequest['audience'] = 'human'): Promise<Omit<db.PermissionRequest, 'payload'>> {
  const live = liveReviewers(a);
  const delegate = audience === 'delegate' && !extra.payload && live.length > 0;
  const noDelegate = audience === 'delegate' && !delegate && !dialog && !extra.payload;
  const r = db.createPermissionRequest(a.id, action, reason, details, dialog, extra.payload ?? null, delegate ? 'delegate' : 'human');
  // A pending request is one wait on the agent, keyed by the request. It makes the agent busy, so
  // its parents wait on it too. The human's is a 'human' wait; a delegate ask waits on the reviewers.
  if (delegate) db.addWait({ agent_id: a.id, kind: 'agent', target: live[0], detail: DELEGATE_WAIT, source: 'stam', data: r.id });
  else db.addWait({ agent_id: a.id, kind: 'human', target: r.id, detail: 'your approval', source: 'stam' });
  syncChildrenWaits(a.id);
  // The request travels as a mail of its own thread; the web UI shows Approve and Deny on it.
  const why = noDelegate ? `_${a.name} has no parent or chief of staff to decide, so this comes to you._\n\n` : '';
  const footer = delegate
    ? `_You decide this: answer with \`answer_permission\` and id \`${r.id}\`, with decision approve, deny or escalate (escalate it to the human, with a one-line reason, when only the human can decide). Never leave it waiting: ${a.name} is blocked until someone answers._`
    : `_The human decides this. ${live.length ? 'Reviewing agents may only deny it' : 'Only the human approves'}: deny with \`answer_permission\` and id \`${r.id}\` if it must not happen._`;
  const d = dialog ? dialogMail(a.name, delegate ? live : [], action, details, reason, { id: r.id }) : undefined;
  const body = d ? render('permission-dialog', { requester: a.name, ...d, id: r.id }) : render('permission-request', { requester: a.name, action, reason, details: fenced(details, extra.fence), id: r.id, why, footer });
  await sendMail({ from: a.id, to: delegate ? live : [HUMAN], subject: (d?.subject ?? `Permission: ${action}`).slice(0, 200), body, permission_id: r.id, new_thread: true });
  // A paused reviewer hears of a human ask too, when it next takes a turn.
  if (!delegate) for (const id of reviewers(a)) if (db.getAgent(id)) queueNotice(id, render('permission-human-notice', { requester: a.name, action, id: r.id }));
  db.addEvent(a.id, 'permission:requested', { id: r.id, action, audience: r.audience });
  return db.publicRequest(r);
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
// the human gets one mail that stands alone, and the requester hears who sent it on and why.
async function handToHuman(r: db.PermissionRequest, a: db.Agent, subject: string, body: string, escalator: string, why: string): Promise<void> {
  db.clearRequestWaits(a.id, r.id);
  db.addWait({ agent_id: a.id, kind: 'human', target: r.id, detail: 'your approval', source: 'stam' });
  syncChildrenWaits(a.id);
  await sendMail({ from: a.id, to: [HUMAN], subject: subject.slice(0, 200), body, permission_id: r.id, new_thread: true });
  queueNotice(a.id, render('permission-escalation-notice', { id: r.id, action: r.action, escalator, why }));
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

function withdrawDialog(a: db.Agent, r: db.PermissionRequest, note: string): void {
  db.withdrawPermissionRequest(r.id, note);
  withdrawQuietly(db.permissionMailIds(r.id), 'stam', `Withdrawn: ${note}`);
  db.addEvent(a.id, 'permission:withdrawn', { id: r.id, note });
  db.clearRequestWaits(a.id, r.id);
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
  if (by !== HUMAN && !delegate) withdrawQuietly(db.permissionMailIds(id), by, `Answered by @${db.getAgent(by)?.name ?? db.findPeerAgent(by)?.name ?? by}: ${approve ? 'approved' : 'denied'}`);
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
  if (r.dialog) return answerDialog(r, a, approve, by, text, who);
  if (r.kind === 'input') return denyInput(r, a, approve, by, text, who);
  if (r.payload) return answerSettings(r, a, approve, by, text, who);
  if (approve && by !== HUMAN && r.audience === 'human') throw new Error(`request ${id} is the human's to approve: leave it to the human, or deny it if it must not happen`);
  db.decidePermissionRequest(id, approve, by, text);
  // The human's approval is typed into the agent's input when that's safe, since auto mode
  // takes only typed input as the user's consent. Agents' answers stay notices.
  let typed = false;
  // Typed input starts a turn: the human's own, so a held agent gets it with a cost:override event.
  if (approve && by === HUMAN) {
    admit(a, 'human');
    typed = (await adapters[a.harness]?.typeHumanInput?.(a, approvedTyped(id, r.action, note))) ?? false;
  }
  // A deny is a failure the agent should record a retro about; an approval is not (S-726).
  if (!typed) {
    const notice = render('permission-answered', { id, action: r.action, verdict: approve ? 'approved' : 'denied', who, note: text, next: answeredNext(approve) });
    queueNotice(a.id, approve ? notice : withFailureRetro(notice));
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
function answerDialog(r: db.PermissionRequest, a: db.Agent, approve: boolean, by: string, text: string, who: string): Omit<db.PermissionRequest, 'payload'> & { typed?: boolean } {
  if (approve && by !== HUMAN) throw new Error(`only the human approves a harness dialog; deny it so ${a.name} carries on without it, or ${r.audience === 'delegate' ? 'escalate it to the human with a one-line reason' : 'leave it to the human'}`);
  const done = adapters[a.harness]?.answerDialog?.(db.getAgent(a.id)!, r, approve) ?? 'gone';
  if (done === 'unsafe') throw new Error(`${a.name}'s dialog on screen doesn't show exactly this request's action with a one-time Yes, so nothing was typed; deny it, or answer it in the terminal`);
  if (done === 'gone') {
    withdrawDialog(a, r, 'no dialog on screen');
    throw new Error(`${a.name} no longer shows this dialog, so request ${r.id} is closed and nothing was typed`);
  }
  db.decidePermissionRequest(r.id, approve, by, text);
  db.addEvent(a.id, 'permission:answered', { id: r.id, approve, by, typed: true });
  db.clearRequestWaits(a.id, r.id);
  // Claude Code reads Esc as an interrupt, which runs no hook: the agent is idle now, and the
  // notice saying why starts its next turn. A harness that carries on sends a hook that says so.
  if (!approve) {
    db.updateAgent(a.id, { activity: 'idle', activity_detail: 'dialog denied' });
    queueNotice(a.id, withFailureRetro(render('permission-answered', { id: r.id, action: r.action, verdict: 'denied', who, note: text, next: answeredNext(false) })));
  }
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
  const problem = costProblem(parsed);
  if (problem) {
    noteInvalid(problem);
    return { error: `cost config rejected: ${problem}` };
  }
  return { text };
}

// Validates the change and asks the human. Returns the request, or the reason the change is invalid (a 400).
export async function requestSettingsChange(a: db.Agent, change: SettingsChange): Promise<{ request: Omit<db.PermissionRequest, 'payload'> } | { error: string }> {
  if (change.kind === 'registry') {
    const current = currentRegistryText();
    const r = resultOf(change, current);
    if ('error' in r) return r;
    const diff = unifiedDiff(current, r.text, 'registry now', 'registry if approved') || 'No visible change.';
    const payload: SettingsPayload = { change, baseHash: hash(current) };
    const request = await requestPermission(a, 'Change stam registry', `${a.name} wants to change stam's registry (STAM_HOME/registry.json)`, diff, false, { payload: JSON.stringify(payload), fence: 'diff' });
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
  const request = await requestPermission(a, 'Change stam settings', `${a.name} wants to change stam's settings (secrets hidden in the diff below)`, diff, false, { payload: JSON.stringify(payload), fence: 'diff' });
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
      writeSettingsText(next.text);
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
export const INPUT_TTL_MS = 30 * 60_000;
const ago = (iso: string | null) => !iso || iso <= new Date().toISOString();
// A fence longer than any run of backticks in the text, so the text shows exactly as written.
const fencedExact = (text: string) => {
  const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((f) => f.length + 1)));
  return `${fence}\n${text}\n${fence}`;
};
const inputNotice = (a: db.Agent, r: db.PermissionRequest, result: string) => queueNotice(a.id, render('input-answered', { id: r.id, result }));

export async function suggestInput(a: db.Agent, text: string, reason: string): Promise<db.PublicRequest> {
  if (a.harness !== 'claude') throw new Error(`suggest_input types into a Claude Code input box only; ${a.name} runs ${a.harness}, whose input stam can't type into this way. Use request_permission instead`);
  const problem = inputProblem(text);
  if (problem) throw new Error(problem);
  // A new suggestion replaces the agent's earlier one, approved and waiting to be typed or not.
  for (const old of [...db.inputRequests('pending', a.id), ...db.inputRequests('held', a.id)]) {
    if (db.moveInputRequest(old.id, old.status, 'withdrawn', { note: 'a newer suggestion replaced it' })) {
      db.addEvent(a.id, 'permission:withdrawn', { id: old.id, note: 'a newer suggestion replaced it' });
      if (old.status === 'pending') withdrawQuietly(db.permissionMailIds(old.id), 'stam', 'Withdrawn: a newer suggestion replaced it');
      db.clearRequestWaits(a.id, old.id);
    }
  }
  const sha256 = hash(text);
  const expires_at = new Date(Date.now() + INPUT_TTL_MS).toISOString();
  const r = db.createPermissionRequest(a.id, 'Type suggested input', reason, '', false, null, 'human', { text, sha256, expires_at });
  db.addWait({ agent_id: a.id, kind: 'human', target: r.id, detail: 'your approval', source: 'stam' });
  syncChildrenWaits(a.id);
  const pub = db.publicRequest(r);
  const body = render('permission-input', { requester: a.name, machine: pub.machine, reason: reason || '(none given)', text: fencedExact(text), expires: expires_at, id: r.id });
  await sendMail({ from: a.id, to: [HUMAN, ...reviewers(a)], subject: `Input for ${a.name}: ${text}`.slice(0, 200), body, permission_id: r.id, new_thread: true });
  db.addEvent(a.id, 'permission:requested', { id: r.id, action: r.action, kind: 'input' });
  return pub;
}

// A denial types nothing. An approval never comes this way: only approveInput, called by the
// route once trustedHuman holds, approves a suggestion.
function denyInput(r: db.PermissionRequest, a: db.Agent, approve: boolean, by: string, text: string, who: string): db.PublicRequest {
  if (approve) throw new Error(`only the human approves suggested input, from stam's web UI on ${db.publicRequest(r).machine}; deny it, or leave it to the human`);
  if (!db.moveInputRequest(r.id, 'pending', 'denied', { by, note: text })) throw new Error(`request ${r.id} is already ${db.getPermissionRequest(r.id)?.status}`);
  queueNotice(a.id, withFailureRetro(render('permission-answered', { id: r.id, action: r.action, verdict: 'denied', who, note: text, next: answeredNext(false) })));
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
    const outcome = await typeHeld(r);
    return { ...db.publicRequest(db.getPermissionRequest(id)!), typed: outcome === 'typed', outcome, ...(outcome === 'held' && heldWhy.has(id) ? { why: heldWhy.get(id) } : {}) };
  }
  if (r.status !== 'pending') throw new InputRefused(`request ${id} is already ${r.status}`);
  if (ago(r.expires_at)) {
    expireInputs();
    throw new InputRefused(`request ${id} expired at ${r.expires_at}`);
  }
  if (typeof sha256 !== 'string' || sha256 !== r.sha256) throw new InputRefused(`text_sha256 doesn't match request ${id}'s text; reload it and approve what it shows`);
  if (!db.moveInputRequest(id, 'pending', 'held', { by: HUMAN, note: 'approved', unexpired: true, session: a.session_id ?? '' })) throw new InputRefused(`request ${id} is already ${db.getPermissionRequest(id)?.status}`);
  db.addEvent(a.id, 'permission:answered', { id, approve: true, by: HUMAN, kind: 'input' });
  settle(a, id);
  heldWhy.delete(id);
  const outcome = await typeHeld(db.getPermissionRequest(id)!, true);
  return { ...db.publicRequest(db.getPermissionRequest(id)!), typed: outcome === 'typed', outcome, ...(outcome === 'held' && heldWhy.has(id) ? { why: heldWhy.get(id) } : {}) };
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

// Types a held approval into its own agent's input, at most one at a time per agent. 'held' when
// the box isn't free yet: the agent is busy, shows a dialog, or someone's draft is in it. Right
// before Enter, one conditional UPDATE moves it from held to approved only if it is still held
// and not expired, and the agent's session is still the approved one; else what was typed is
// erased ('cancelled'), so a suggestion withdrawn or expired mid-typing is never sent.
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
      if (db.moveInputRequest(r.id, 'held', 'failed', { note: `not typed: ${admitted.reason}` })) inputNotice(a, r, `was approved, but stam didn't type it: ${admitted.reason}.`);
      return 'failed';
    }
    // The transcript's size right before Enter: a bash-mode command is looked for after it.
    let offset = 0;
    const proceed = async () => {
      await testBarrier();
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
      inputNotice(a, r, 'was approved by your user (the human) and typed into your input as written.');
      return 'typed';
    }
    if (done === 'cancelled') {
      db.addEvent(a.id, 'input:cancelled', { id: r.id, status: db.getPermissionRequest(r.id)?.status });
      // Still held means only the session changed under it.
      if (db.getPermissionRequest(r.id)?.status === 'held') expireHeld(a, now, 'its harness session changed while stam typed it');
      return 'cancelled';
    }
    if (done === 'failed' && db.moveInputRequest(r.id, 'held', 'failed', { note: "the input box didn't show exactly the text" })) {
      db.addEvent(a.id, 'input:failed', { id: r.id });
      inputNotice(a, r, "was approved, but after typing it your input box didn't show exactly the text with nothing under it, so stam erased what it typed and sent nothing. Suggest it again if you still need it.");
      return 'failed';
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
  if (why === 'draft') {
    // Whenever a draft first blocks the input, also after a busy start: the agent is told what to clear, and the chief of staff why.
    if (draftTold.has(r.id)) return 'held';
    draftTold.add(r.id);
    const box = adapters[a.harness]?.inputText?.(a);
    db.addEvent(a.id, 'input:held', { id: r.id, why, ...(box !== undefined ? { box: box.slice(0, 200) } : {}) });
    const shown = box === undefined ? 'text' : `\`${box.slice(0, 200).replace(/`/g, "'")}\``;
    inputNotice(a, r, `was approved by your user (the human), but stam can't type it: your input box holds ${shown}, which stam didn't type. Clear your input box (Ctrl+U) and stam types it at once; until ${r.expires_at}.`);
    const cos = settings().chiefOfStaff;
    if (cos && cos !== a.id) sendMail({ from: a.id, to: [cos], subject: `Approved input for ${a.name} is held by text in its box`, body: `Your user approved input ${r.id} for @${a.name}, but its input box holds ${shown}, which stam didn't type. stam told the agent to clear it; the approval expires at ${r.expires_at}.`, from_stam: true }).catch((e) => db.addEvent(a.id, 'permission-error', String(e)));
  } else if (first) {
    db.addEvent(a.id, 'input:held', { id: r.id, why });
    inputNotice(a, r, `was approved by your user (the human). End your turn so stam can type it into your input; you continue after. stam types it as soon as you are idle with an empty box, until ${r.expires_at}.`);
  }
  return 'held';
}

// A held approval that won't be typed: the agent hears, and the human is told once in its thread.
function expireHeld(a: db.Agent, r: db.PermissionRequest, why: string): void {
  if (!db.moveInputRequest(r.id, 'held', 'expired', { note: why })) return;
  db.addEvent(a.id, 'input:expired', { id: r.id, was: 'held', why });
  inputNotice(a, r, `expired: ${why}, so nothing was typed.`);
  tellHuman(a, r, `[stam] Approved input for ${a.name} expired untyped`, render('input-expired-human', { requester: a.name, id: r.id, why }));
}

function tellHuman(a: db.Agent, r: db.PermissionRequest, subject: string, body: string): void {
  const m = db.permissionMail(r.id);
  sendMail({ from: a.id, to: [HUMAN], subject, body, reply_to: m?.id, from_stam: true }).catch((e) => db.addEvent(a.id, 'permission-error', String(e)));
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

// A typed bash-mode command must show in the agent's transcript within EXPECT_MS (bashInputRecorded).
// Only what was appended after Enter counts (from `offset`), since the agent's own suggest_input
// call earlier in the transcript holds the text too. If another command shows first, or none does,
// the human is told once.
async function checkTranscript(a: db.Agent, r: db.PermissionRequest, offset: number): Promise<void> {
  for (const until = Date.now() + EXPECT_MS; Date.now() < until; await new Promise((res) => setTimeout(res, 1000))) {
    const file = db.getAgent(a.id)?.transcript_path;
    try {
      const all = file ? readFileSync(file) : undefined;
      const seen = all ? bashInputRecorded(all.subarray(Math.min(offset, all.length)).toString('utf8'), r.text!) : 'none';
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
// may still be drawing the box, so it tries a few times; the sweep below tries again later.
export async function typeHeldInput(agentId: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const r = db.inputRequests('held', agentId)[0];
    if (!r || (await typeHeld(r)) !== 'held') return;
    await new Promise((res) => setTimeout(res, 300));
  }
}

// Every few seconds: suggestions past expires_at expire (a held one tells the human once, in its
// thread, and types nothing; one being typed is erased before Enter), and held ones whose agent is
// idle are tried again.
export function expireInputs(): void {
  for (const r of db.inputRequests('pending')) {
    if (!ago(r.expires_at) || !db.moveInputRequest(r.id, 'pending', 'expired')) continue;
    const a = db.getAgent(r.agent_id);
    if (!a) continue;
    db.addEvent(a.id, 'input:expired', { id: r.id, was: 'pending' });
    withdrawQuietly(db.permissionMailIds(r.id), 'stam', `Withdrawn: it expired at ${r.expires_at} without an answer`);
    inputNotice(a, r, `expired at ${r.expires_at} without an answer, so nothing was typed.`);
    settle(a, r.id);
  }
  for (const r of db.inputRequests('held')) {
    const a = db.getAgent(r.agent_id);
    if (ago(r.expires_at) && a) expireHeld(a, r, `it expired at ${r.expires_at} before the input box was free`);
    // The agent went busy: the box text the card showed is stale, and a restart would cut a turn.
    else if (a && a.activity !== 'idle' && a.activity !== 'waiting' && r.note?.startsWith('box:')) db.setHeldBox(r.id, null);
  }
}

export async function retryHeldInputs(): Promise<void> {
  expireInputs();
  for (const r of db.inputRequests('held')) {
    const a = db.getAgent(r.agent_id);
    if (a && (a.activity === 'idle' || a.activity === 'waiting')) await typeHeld(r).catch((e) => db.addEvent(r.agent_id, 'permission-error', String(e)));
  }
}
