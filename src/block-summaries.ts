// Block summaries (S-878, stage 1 of S-868/S-876): a short, automatic summary of an instruction
// text block, cached by the sha256 of its text and the model and prompt it was asked with (S-1684),
// so a read-only Instructions inventory
// can show two lines per block without asking a model twice. Modelled on src/mail-title.ts: the
// same OpenRouter key (src/credits.ts) and the stubbable base URL (STAM_OPENROUTER_URL), a bounded
// queue, a few calls at once, a short timeout and no retry, the cost recorded under
// openrouter/block-summary; a caller is never blocked or delayed. With no model set nothing is
// asked (state 'off'); a hit never calls the model. A failure is remembered in memory only, so a
// restart tries the block again.
import { createHash } from 'node:crypto';
import * as db from './db.ts';
import { settings, onSettingsChange } from './settings.ts';
import { apiKey } from './credits.ts';
import { recordSpend } from './decide.ts';
import { complete } from './llm/index.ts';
import { systemHeld } from './budgets.ts';
import { configHash } from './config-hash.ts';

const PURPOSE = 'block-summary';
// The shipped system prompt, the default of the editable one in Settings › Tiny models (src/tiny-models.ts).
export const SUMMARY_PROMPT =
  'You summarise one block of an AI agent\u2019s standing instructions. Answer with one or two plain sentences, at most 200 characters, saying what the block tells the agent to do. No preamble, no lists, no Markdown.';
// The prompt asked with: the human's override, or the shipped one when empty.
export function summaryPrompt(): string {
  const own = settings().tiny.blockSummaries.instructions;
  return own.trim() ? own : SUMMARY_PROMPT;
}
const TIMEOUT_MS = 15_000;
// Calls at once, and blocks waiting beyond those; a block past the queue is asked on a later call.
const CONCURRENCY = 2;
const QUEUE_MAX = 100;
// How much of the block the model sees, and how long its answer may be.
const TEXT_CHARS = 4000;
const MAX_CHARS = 200;

// What the inventory shows for one block: its cached summary (state 'auto'), 'pending' while the
// call is queued or in flight, 'off' when no model is set, or 'failed' for a call that failed
// since this process started.
export type BlockSummary = { summary?: string; state: 'auto' | 'pending' | 'off' | 'failed' };

// The model and prompt a job is asked with, and their hash (`config`): a job keeps them from when it was queued.
type Job = { hash: string; text: string; title?: string; model: string; prompt: string; config: string };
const queue: Job[] = [];
const inFlight = new Set<AbortController>();
// Queued or in flight, so the same text is asked about once.
const asked = new Set<string>();
// Blocks whose call failed since this process started, with the config they failed with; a restart
// tries them again, and a change of model or prompt asks them again.
const failed = new Map<string, string>();
// Blocks dropped because the queue was full, logged as one event once the queue drains.
let skipped = 0;

// The model, read on first use and refreshed on every settings write; '' is off. The listener is
// added on first use too, since settings.ts may still be loading when this module is.
let model: string | undefined;
function current(): string {
  if (model === undefined) {
    onSettingsChange(refresh);
    model = settings().instructions.summaries.model;
  }
  return model;
}
function refresh(): void {
  model = settings().instructions.summaries.model;
  if (model) return;
  // Off: nothing queued runs, and calls in flight stop.
  queue.length = 0;
  asked.clear();
  for (const c of inFlight) c.abort();
  flushSkipped();
}

// The summary for this block: the cached one, or 'pending' with the call queued. `hash` is the
// sha256 hex of `text`; `title` is the block's label, when it has one. Never blocks.
export function summaryFor(hash: string, text: string, title?: string): BlockSummary {
  const m = current();
  const prompt = summaryPrompt();
  const config = configHash(m, prompt);
  const cached = db.getBlockSummary(hash);
  // A summary asked with another model or prompt is a miss, so editing either asks again. With the model
  // off, the stored summary still shows, as it did before the model and prompt were part of the key.
  if (cached && (!m || cached.configHash === config)) return { summary: cached.summary, state: 'auto' };
  if (!m) return { state: 'off' };
  if (failed.get(hash) === config) return { state: 'failed' };
  enqueue({ hash, text, title, model: m, prompt, config });
  return { state: 'pending' };
}

// The summaries for a batch of blocks, keyed by hash. A block the batch repeats is asked once.
export function summariesFor(blocks: { hash: string; text: string; title?: string }[]): Record<string, BlockSummary> {
  const out: Record<string, BlockSummary> = {};
  for (const b of blocks) if (!(b.hash in out)) out[b.hash] = summaryFor(b.hash, b.text, b.title);
  return out;
}

function enqueue(job: Job): void {
  if (asked.has(job.hash)) return;
  if (queue.length >= QUEUE_MAX) {
    skipped++;
    return;
  }
  asked.add(job.hash);
  queue.push(job);
  // The calls start after the caller returns, so a caller is never held up by a model.
  if (pumpSoon) return;
  pumpSoon = true;
  setImmediate(() => {
    pumpSoon = false;
    pump();
  });
}
let pumpSoon = false;

function pump(): void {
  while (inFlight.size < CONCURRENCY && queue.length && current()) {
    const job = queue.shift()!;
    const ctl = new AbortController();
    inFlight.add(ctl);
    void summarize(job, ctl.signal)
      .catch(() => {})
      .finally(() => {
        inFlight.delete(ctl);
        asked.delete(job.hash);
        pump();
      });
  }
  if (!queue.length) flushSkipped();
}

function flushSkipped(): void {
  if (!skipped) return;
  db.addEvent('stam', 'block-summary:skipped', { count: skipped, reason: 'queue full' });
  skipped = 0;
}

async function summarize(job: Job, signal: AbortSignal): Promise<void> {
  const key = apiKey();
  if (!current()) return;
  const m = job.model;
  // The system budget is spent: fail the block, as with no key.
  if (systemHeld()) {
    failed.set(job.hash, job.config);
    return;
  }
  // No OpenRouter key: nothing can be asked, so the block is failed, not pending forever.
  if (!key) {
    failed.set(job.hash, job.config);
    return;
  }
  let data;
  try {
    data = await complete({
      model: m,
      messages: [
        { role: 'system', content: job.prompt },
        { role: 'user', content: job.title ? `Block: ${job.title}\n\n${job.text.slice(0, TEXT_CHARS)}` : job.text.slice(0, TEXT_CHARS) },
      ],
      maxTokens: 120,
      temperature: 0,
      signal,
      timeoutMs: TIMEOUT_MS,
    });
  } catch (e) {
    const canceled = signal.aborted;
    // A canceled call was turned off, not failed; the block is asked again if the model returns.
    if (!canceled) failed.set(job.hash, job.config);
    db.addEvent('stam', canceled ? 'block-summary:canceled' : 'block-summary:error', {
      hash: job.hash,
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  recordSpend(PURPOSE, data.model, data.costUsd ?? 0, data.usage.inputTokens, data.usage.outputTokens);
  const s = cleanSummary(data.text);
  if (!s) {
    failed.set(job.hash, job.config);
    return;
  }
  db.setBlockSummary(job.hash, s, data.model, job.config);
}

// The model's answer as a summary: one line, without Markdown marks, a "Summary:" label, or extra
// whitespace, cut to 200 characters. Null when nothing is left.
export function cleanSummary(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\s*(summary|title)\s*:\s*/i, '')
    .trim()
    .slice(0, MAX_CHARS)
    .trim();
  return s || null;
}

// The sha256 hex the cache keys a block by; the inventory hashes a block's text with it.
export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
