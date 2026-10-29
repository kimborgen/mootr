// Mail titles (S-297): when stam stores a mail and settings.mail.titles.model names an
// OpenRouter model, ask that model for a title of at most three words, for scanning the mail
// list. It never blocks or delays delivery: the work is scheduled after sendMail returns, a few
// calls at a time, once per mail, with a short timeout and no retry; a failure stores nothing.
// With no model set nothing is asked, and the check reads a cached copy of the setting, which
// every settings write refreshes. Clearing the model drops the queue and aborts calls in flight.
// The daemon that stored the mail first asks; the title then goes to the peers that hold the
// mail (in its queued forward, or by a call), so a recipient's copy shows it without asking
// again. A mail to the human gets a condensed copy of its content too (S-1001, S-1111), from the same call, for the
// swipe cards; it travels like the title. The key and the stubbable base URL are the ones src/credits.ts uses; the cost is
// recorded like a decide call, so the Usage page shows openrouter/mail-title.
import * as db from './db.ts';
import { settings, onSettingsChange } from './settings.ts';
import { recordSpend } from './decide.ts';
import { complete, hasKey, parseModelRef } from './llm/index.ts';
import { askBlocked, spendTo } from './tiny-spend.ts';
import { configHash } from './config-hash.ts';
import { peerByName, peerCall } from './peers.ts';

const PURPOSE = 'mail-title';
const HUMAN = 'human';
const TIMEOUT_MS = 15_000;
// Calls at once, and mails waiting beyond those; a mail past the queue gets no title.
const CONCURRENCY = 2;
const QUEUE_MAX = 100;
// How much of the body the model sees: more for a mail to the human, which gets a summary.
const BODY_CHARS = 2000;
const BODY_CHARS_HUMAN = 3000;
const MAX_WORDS = 3;
const MAX_CHARS = 40;
// A summary is a condensed version of the mail itself (S-1111), shaped by the mail's type
// (S-1311): a decision is its question and up to four option lines, so five lines in all; a
// blocker or a done mail is a few labelled lines. The cap is on stored characters and lines.
const SUMMARY_CHARS = 400;
const SUMMARY_LINES = 5;
// A last line that is the model's sign-off, not content. Only trailing lines are tested, and only
// stock closings: "Let me know which one by Friday." and "If you approve, it runs" stay.
const CHATTER = /^(let me know if (you|there)|hope (this|that) helps|feel free to|i can also|happy to help)/i;

// The shipped system prompts, the defaults of the editable ones in Settings › Tiny models (src/tiny-models.ts).
export const TITLE_PROMPT =
  'You title mail. Answer with a title of one to three words that says what the mail is about, and nothing else.';
export const SUMMARY_PROMPT =
  'You title and summarize mail. Answer in this form. First line: "Title: " and a title of one to three words that says what the mail is about. Then "Summary: " and a condensed version of the mail itself, not a description of it, so the reader need not open the mail. Shape the summary by the type of mail you find. Decision (someone must choose between options): the question to decide on the summary line, then one "- Option: why" line per option, at most four, the recommended one ending in " (recommended)". Blocker (work cannot go on): "Problem: " with the problem, then "Solution: " with what would clear it, including what the human must do. Done (work is finished): "Problem: " with what the problem was, then "Solution: " with what was done, then "Deferred: " for items left for later and "Note: " for anything the reader must know, each line only when it applies. Any other mail: plain condensed text over at most four short lines, keeping the outcome, the ask, key numbers, and names such as S-12, @agent or PR #12. Use no Markdown beyond the "- " option lines and the labels, and write nothing else.';

// The system prompt: the human's override from Settings › Tiny models, or the shipped one when empty.
export function titlePrompt(summary: boolean): string {
  const t = settings().tiny.mailTitles;
  const own = summary ? t.summaryInstructions : t.titleInstructions;
  return own.trim() ? own : summary ? SUMMARY_PROMPT : TITLE_PROMPT;
}

type Job = { id: string; subject: string; body: string; peers: string[]; summary: boolean };
const queue: Job[] = [];
const inFlight = new Set<AbortController>();
// Mails queued or running from a view (mailTitlesShown), so one mail is asked about once at a time.
const busy = new Set<string>();
// A mail whose call failed or gave no title, by mail and the config it was asked with (S-1843): a view
// doesn't ask it again until the model or prompt changes.
const failed = new Set<string>();
const failedAt = (id: string, cfg: string) => `${id}\u0000${cfg}`;
// Mails a view names at once, and the most a request may name (S-1843).
const SHOWN_MAX = 40;
// Mails dropped because the queue was full, logged as one event once the queue drains.
let skipped = 0;

// The model, read on first use and refreshed on every settings write; '' is off. The listener
// is added on first use too, since settings.ts may still be loading when this module is.
let model: string | undefined;
function current(): string {
  if (model === undefined) {
    onSettingsChange(refresh);
    model = settings().mail.titles.model;
  }
  return model;
}
function refresh(): void {
  model = settings().mail.titles.model;
  if (model) return;
  // Off: nothing queued runs, and calls in flight stop.
  queue.length = 0;
  busy.clear();
  for (const c of inFlight) c.abort();
  flushSkipped();
}

// Queues a title for a mail just stored, when titles are on. `peers` names the peer daemons the
// mail went to (or waits for), which get the title once it is known. The mail joins the bounded
// queue at once, so turning titles off drops it; the calls start after sendMail returns.
export function maybeTitleMail(m: { id: string; subject: string; body: string }, peers: string[] = [], toHuman = false): void {
  if (!current()) return;
  if (queue.length >= QUEUE_MAX) {
    skipped++;
    return;
  }
  // Busy at once, so a view that shows the mail while this call is queued doesn't queue a second one (S-1843).
  busy.add(m.id);
  queue.push({ id: m.id, subject: m.subject ?? '', body: (m.body ?? '').slice(0, toHuman ? BODY_CHARS_HUMAN : BODY_CHARS), peers, summary: toHuman });
  kick();
}
let pumpSoon = false;

// The calls start after the caller returns, so a caller is never held up by a model.
function kick(): void {
  if (pumpSoon) return;
  pumpSoon = true;
  setImmediate(() => {
    pumpSoon = false;
    pump();
  });
}

function pump(): void {
  while (inFlight.size < CONCURRENCY && queue.length && current()) {
    const job = queue.shift()!;
    const ctl = new AbortController();
    inFlight.add(ctl);
    void title(job, ctl.signal)
      .catch(() => {})
      .finally(() => {
        inFlight.delete(ctl);
        busy.delete(job.id);
        pump();
      });
  }
  if (!queue.length) flushSkipped();
}

function flushSkipped(): void {
  if (!skipped) return;
  db.addEvent('stam', 'mail-title:skipped', { count: skipped, reason: 'queue full' });
  skipped = 0;
}

async function title(job: Job, signal: AbortSignal): Promise<void> {
  const m = current();
  if (!m || !hasKey(m)) return;
  const prompt = titlePrompt(job.summary);
  const cfg = configHash(m, prompt);
  const held = askBlocked(m);
  if (held) return void db.addEvent('stam', 'mail-title:skipped', { id: job.id, reason: held });
  let data;
  try {
    data = await complete({
      model: m,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `Subject: ${job.subject}\n\n${job.body}` },
      ],
      maxTokens: job.summary ? 260 : 16,
      temperature: 0,
      signal,
      timeoutMs: TIMEOUT_MS,
    });
  } catch (e) {
    if (!signal.aborted) failed.add(failedAt(job.id, cfg));
    db.addEvent('stam', signal.aborted ? 'mail-title:canceled' : 'mail-title:error', { id: job.id, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  const to = spendTo(parseModelRef(m).provider);
  recordSpend(PURPOSE, to ? `${to.provider}:${data.model}` : data.model, data.costUsd ?? 0, data.usage.inputTokens, data.usage.outputTokens, to);
  const content = data.text;
  const { title: t, summary: s } = job.summary ? parseBoth(content) : { title: cleanTitle(content), summary: null };
  // An answer with neither field is a failure for this config. One with either is current for it: a summary
  // alone isn't asked again, and a title alone isn't either.
  if (!t && !s) return void failed.add(failedAt(job.id, cfg));
  if (t) db.setMailTitle(job.id, t, cfg);
  else db.setMailTitleConfig(job.id, cfg);
  if (s) db.setMailSummary(job.id, s);
  for (const name of job.peers) void sendToPeer(job.id, name, t, s);
}

// The mails a view shows (S-1843): a title or summary asked with another model or prompt hash (or none,
// from before the column or a peer) is stale and asked again, once, and the old text shows until the new
// one lands. Nothing is asked with the model off, and nothing for a mail that is current. Returns the
// mails still being asked, so the view asks again until they land. Peer copies aren't asked.
export interface MailTitlesShown { enabled: boolean; pending: string[] }
export function mailTitlesShown(ids: string[]): MailTitlesShown {
  const m = current();
  if (!m) return { enabled: false, pending: [] };
  const canAsk = askBlocked(m) === null;
  const pending: string[] = [];
  let queued = false;
  for (const id of ids.slice(0, SHOWN_MAX)) {
    if (busy.has(id)) {
      pending.push(id);
      continue;
    }
    const row = db.mailTitleRow(id);
    const mail = row && db.getMail(id);
    if (!row || !mail) continue;
    // A peer's copy is the peer's to regenerate, never this daemon's (S-1843).
    if (row.configHash === db.PEER_TITLE_CONFIG) continue;
    const toHuman = db.mailRecipientIds(id).includes(HUMAN);
    const cfg = configHash(m, titlePrompt(toHuman));
    if (row.configHash === cfg || failed.has(failedAt(id, cfg))) continue;
    if (!canAsk || queue.length >= QUEUE_MAX) continue;
    busy.add(id);
    queue.push({ id, subject: mail.subject ?? '', body: (mail.body ?? '').slice(0, toHuman ? BODY_CHARS_HUMAN : BODY_CHARS), peers: [], summary: toHuman });
    pending.push(id);
    queued = true;
  }
  if (queued) kick();
  return { enabled: true, pending };
}

// A peer that holds the mail gets its title and summary: a forward still queued for it carries
// them, and a peer that has the mail is told now. A peer that can't be reached keeps none.
async function sendToPeer(id: string, name: string, t: string | null, s: string | null): Promise<void> {
  db.outboxSetTitle(id, name, t ?? '', s ?? undefined);
  const peer = peerByName(name);
  if (!peer) return;
  try {
    await peerCall(peer, 'POST', `/api/mail/${id}/title`, { title: t ?? undefined, summary: s ?? undefined });
  } catch (e) {
    db.addEvent('stam', 'mail-title:peer-error', { id, peer: name, error: e instanceof Error ? e.message : String(e) });
  }
}

// The model's answer as a title: its first line, without a "Title:" label, quotes, Markdown
// marks or end punctuation, cut to three words and 40 characters. Null when nothing is left.
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const words = line
    .replace(/[*_`#"“”‘’]/g, '')
    .replace(/^\s*title\s*:\s*/i, '')
    .replace(/^['\s]+|['\s]+$/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_WORDS);
  const t = words.join(' ').replace(/[.,;:!?]+$/, '').slice(0, MAX_CHARS).trim();
  return t || null;
}

// The answer to a title-and-summary prompt: the title from its "Title:" line and the summary from
// the "Summary:" text, in either order, on separate lines or on one ("Title: X Summary: Y"). An
// answer with neither label is read as a bare title, as in a title-only prompt.
export function parseBoth(raw: unknown): { title: string | null; summary: string | null } {
  if (typeof raw !== 'string') return { title: null, summary: null };
  // A label may follow a short prefix ("Line 1: ", "1. ", "- ") and needs text after it.
  const t = raw.match(/^[*_`#>\-\t ]*(?:(?:line[ \t]*)?\d+[ \t]*[:.)][ \t]*)?[*_`\t ]*title[*_`]*[ \t]*:(.*?)(?=[*_`]*\bsummary[*_`]*[ \t]*:[*_`\t ]*\S|$)/im);
  const s = raw.match(/\bsummary[*_`]*[ \t]*:[*_`\t ]*\n?(?!\s*[*_`]*title)[*_`\t ]*(\S[\s\S]*)$/im);
  if (!t && !s) return { title: cleanTitle(raw), summary: null };
  return { title: t ? cleanTitle(t[1]) : null, summary: s ? cleanSummary(s[1].split(/\n[*_`#>\t ]*(?:(?:line[ \t]*)?\d+[ \t]*[:.)][ \t]*)?[*_`\t ]*title[*_`]*[ \t]*:/i)[0]) : null };
}

// A summary: a condensed version of the mail, up to five lines, without a "Summary:" label,
// quotes or Markdown marks other than "- " bullets, cut to 400 characters. The shape labels
// ("Problem:", "Solution:", "Deferred:", "Note:") stay as written. Later paragraphs stay (an ask
// often comes last); a trailing sign-off line is dropped. Null when nothing is left.
export function cleanSummary(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const lines: string[] = [];
  for (const l of raw.split('\n')) {
    const t = l
      .replace(/^\s*[•*+]\s+/, '- ')
      .replace(/[*`"“”‘’]/g, '')
      .replace(/^\s*#+\s+/, '')
      .replace(/^\s*summary\s*:\s*/i, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (t) lines.push(t);
  }
  while (lines.length && CHATTER.test(lines[lines.length - 1])) lines.pop();
  const t = cutText(lines.slice(0, SUMMARY_LINES).join('\n'), SUMMARY_CHARS);
  return t || null;
}

// Text cut to `max` code points (never inside a surrogate pair), at a word boundary when one is
// near, with an ellipsis; text that fits is returned as is.
export function cutText(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1);
  const at = head.findLastIndex((c) => /\s/.test(c));
  return (at > max / 2 ? head.slice(0, at) : head).join('').trimEnd() + '…';
}
