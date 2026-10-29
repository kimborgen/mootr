// An ask's home thread (S-3827): an ask that reaches the human (request_permission, an escalated delegate ask, a harness
// dialog sent on to the human, suggest_input, settings_ask) joins the thread its work lives in, instead of a thread of
// its own. In order:
// 1. the thread where the ask arose, when the agent names it (`thread`, a mail id it may read);
// 2. else the agent's ITSA thread: the `itsa` it names, else the one ITSA it owns whose status is active;
// 3. else a new thread, as before. For now (staged, S-3827) the ask is sent there with a "No home thread" line, a
//    `permission:no-home` event and a hint to the agent; REFUSE_WITHOUT_HOME turns that into a refusal, which an
//    `override` reason (recorded and shown in the ask already) gets past. A `thread` or `itsa` the agent can't read
//    is refused now: naming one is an explicit error.
// When the home is an origin thread and the agent also has an ITSA, a one-line link goes in the ITSA's thread.
// Only the placement changes: the recipients, the audience and who may answer stay as they were, and the ask stays
// visible to exactly those who saw it before (mail-visibility.ts isPlacedAsk).
import * as db from './db.ts';
import { HUMAN, readableThread, sendMail } from './mail.ts';
import { askItsa, OldHome, type AskItsa } from './itsa-owners.ts';
import { ASK_LINK } from './mail-visibility.ts';
import { ForbiddenError } from './itsa.ts';

export interface HomeInput {
  thread?: unknown;
  itsa?: unknown;
  override?: unknown;
}

export interface Home {
  // The thread the ask's mail joins; null starts a new one.
  thread: string | null;
  // The ITSA the ask belongs to, when it has one.
  itsa: AskItsa | null;
  // The agent's reason for a new thread (step 3).
  override: string | null;
  // A new ask to the human that found no home and gave no reason (step 3, not yet refused).
  noHome?: boolean;
}

// Step 3 refuses an ask without a home or an override once this is true. Off while agents still run the old tool
// schema, which has no thread, itsa or override (S-3827 is staged): such an ask goes to a new thread instead.
const REFUSE_WITHOUT_HOME = false;

// How long a fallback ask (a dialog, an escalation) waits for the ITSA home before it goes to a new thread.
const FALLBACK_MS = 2000;

// A refusal: the ask is sent nowhere and nothing is stored (the routes answer it as a 400).
export class HomeRefused extends Error {}

// The home fields of a request body (request_permission, suggest_input, settings_ask).
export const homeOf = (body: any): HomeInput => ({ thread: body?.thread, itsa: body?.itsa, override: body?.override });

const line = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 300) : '');

// How strict the lookup is. 'human': a new ask to the human, whose named thread or ITSA must be readable. 'delegate': an ask for the parent or
// the chief of staff, which only remembers the thread or ITSA the agent names (checked), for when it reaches the human.
// 'fallback': an ask stam sends on to the human itself (a dialog, an escalation): never refused, a new thread without a home.
export type HomeMode = 'human' | 'delegate' | 'fallback';

export async function askHome(a: db.Agent, input: HomeInput, mode: HomeMode, tool = 'request_permission'): Promise<Home> {
  const thread = line(input.thread);
  const itsaRef = line(input.itsa);
  const override = line(input.override);
  const strict = mode !== 'fallback';
  let home: string | null = null;
  if (thread) {
    const t = await readableThread(thread, a.id).catch((e) => {
      if (strict) throw new HomeRefused(`${tool}: couldn't look up mail ${thread}: ${e instanceof Error ? e.message : e}`);
      return null;
    });
    if (t === 'hidden' && strict) throw new HomeRefused(`${tool}: mail ${thread} isn't visible to you, so the ask can't go in its thread. Name a mail you can read (read_thread shows them), or leave \`thread\` out.`);
    if (t === null && strict) throw new HomeRefused(`${tool}: no mail ${thread}, so the ask can't go in its thread. Name a mail id you can read, or leave \`thread\` out.`);
    if (t && t !== 'hidden') home = t;
  }
  let itsa: AskItsa | null = null;
  // A delegate ask looks up only the ITSA it names; its own ITSA is found when it reaches the human.
  // A dialog or an escalation waits on the ITSA home briefly: its row doesn't exist until this answers.
  // A named `itsa` is refused only for the home's answer about it: the agent may not ask there (a 403), or there is no
  // such ITSA. An ITSA home that is down, slow or old (OldHome) is no ITSA: an agent blocked on a safety check can still
  // ask the human, in a new thread.
  if (itsaRef || mode !== 'delegate') {
    try {
      itsa = await askItsa(a.id, itsaRef || undefined, strict ? 8000 : FALLBACK_MS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const answered = e instanceof ForbiddenError || /\bno ITSA /.test(msg) || (e instanceof OldHome && REFUSE_WITHOUT_HOME);
      if (itsaRef && strict && answered) throw new HomeRefused(`${tool}: ${msg}`);
    }
  }
  if (mode === 'delegate') return { thread: home, itsa, override: override || null };
  if (!home && itsa) home = itsa.thread_id;
  if (!home && !override && mode === 'human') {
    db.addEvent(a.id, 'permission:no-home', { tool });
    if (REFUSE_WITHOUT_HOME) throw new HomeRefused(`${tool}: the ask has no home thread, so it isn't sent. ${NO_HOME_HINT}`);
    return { thread: null, itsa, override: null, noHome: true };
  }
  return { thread: home, itsa, override: home ? null : override || null };
}

// What an agent whose ask found no home hears, in its tool result or refusal.
export const NO_HOME_HINT = "Next time pass `thread` (the id of the mail it arose from, one you can read) or `itsa` (the ITSA it is for; you own several or none that is active), so your user sees it with its work; only if neither fits, `override` with a one-line reason. These work even if your tool schema doesn't list them yet.";

// The line an ask's mail starts with when it went to a new thread: the agent's override reason, or that it had no home.
export function overrideNote(home: Home): string {
  return home.override ? `_Asked in a new thread: ${home.override}_\n\n` : home.noHome ? '_No home thread_\n\n' : '';
}

// The send fields that put the ask's mail in its home thread, or in a new one.
export function placement(home: Home): { thread_id: string; placed: true } | { new_thread: true } {
  return home.thread ? { thread_id: home.thread, placed: true } : { new_thread: true };
}

// The one-line link in the ITSA's thread to an ask that went to another thread (its origin). It goes to the human alone,
// from the asking agent, so it is sealed as the ask is (ASK_LINK): the ITSA's other readers don't see it.
export async function postAskLink(a: db.Agent, home: Home, mailId: string, action: string): Promise<void> {
  if (!home.itsa || !home.thread || home.thread === home.itsa.thread_id) return;
  const what = action.replace(/\s+/g, ' ').trim();
  try {
    await sendMail({ from: a.id, to: [HUMAN], subject: `Re: ${home.itsa.key} ${home.itsa.title}`.slice(0, 200), body: `Ask in ${mailId}: ${what.length > 200 ? what.slice(0, 199) + '…' : what}`, thread_id: home.itsa.thread_id, placed: true, kind: ASK_LINK, from_stam: true });
  } catch (e) {
    db.addEvent(a.id, 'permission-error', `ask link in ${home.itsa.key}: ${e instanceof Error ? e.message : e}`);
  }
}
