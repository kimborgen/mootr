// Tool-call summaries (S-1481): the conversation view shows each tool call as two short fields,
// the tool in plain English and what the agent is doing, written by the cheapest model
// (Settings › Tiny models › Tool summary, src/tiny-models.ts). Lazy: the web asks only for the
// calls it shows, a batch at a time in priority order, and each call is summarised once and
// stored in stam.db by agent, call id and a hash of its name and input, so a request naming a
// call with another input neither reads nor fixes its summary. A stored summary carries the hash
// of the model and prompt it was asked with (S-1843): when it is shown with another hash, or none
// (a row from before the column), it shows at once and is asked again, and the new answer replaces
// it. Nothing is asked in bulk. Modelled on src/block-summaries.ts: the same OpenRouter
// key and stubbable base URL, a bounded queue, a few calls at once, a short timeout and no retry,
// the cost under openrouter/tool-summary. A newer batch goes ahead of what older batches queued,
// since the view has moved on. The answer must be JSON with both fields within their word caps;
// anything else stores nothing, and the call is remembered as failed until a restart. With no
// OpenRouter key or the system budget spent nothing is asked, and the next request tries again.
// With the step off (its toggle or its model), stored summaries still show and nothing is asked.
import { createHash } from 'node:crypto';
import * as db from './db.ts';
import { settings, onSettingsChange } from './settings.ts';
import { apiKey } from './credits.ts';
import { recordSpend } from './decide.ts';
import { systemHeld } from './budgets.ts';
import { configHash } from './config-hash.ts';
import { toolSummaryConfig, TOOL_SUMMARY_FIELDS, type ToolSummaryConfig } from './tiny-models.ts';

const base = () => process.env.STAM_OPENROUTER_URL ?? 'https://openrouter.ai/api/v1';
const PURPOSE = 'tool-summary';
const TIMEOUT_MS = 15_000;
// Calls at once, and calls waiting beyond those; the oldest batch's calls drop off the queue's end.
const CONCURRENCY = 3;
const QUEUE_MAX = 60;
// Calls one request may name, how much of a call's input the model sees, and the longest wait.
export const BATCH_MAX = 40;
export const ID_CHARS = 200;
const INPUT_CHARS = 2000;
export const WAIT_MAX_MS = 10_000;
const TOOL_WORDS = 3;
const TOOL_CHARS = 40;
const DOING_CHARS = 160;

export interface ToolSummary { tool: string; doing: string }
export interface ToolCallIn { id: string; name: string; input?: unknown }
// What the web gets back: the stored summaries by call id, and the calls still being asked about.
// Disabled, the step returns nothing and asks nothing.
export interface ToolSummaries { enabled: boolean; summaries: Record<string, ToolSummary>; pending: string[] }

// A job keeps the config it was queued with, and the hash of it, so a settings change while it waits
// or runs doesn't mix the two.
type Job = { key: string; agent: string; call: ToolCallIn; hash: string; config: ToolSummaryConfig; cfg: string; running: boolean; done: Promise<void>; finish: () => void };
const queue: Job[] = [];
// Queued or in flight, by agent, call id and input hash, so one call is asked about once.
const jobs = new Map<string, Job>();
const inFlight = new Set<AbortController>();
// Calls whose answer failed or was refused since this process started; a restart tries them again.
const failed = new Set<string>();
// A failure is for the config it was asked with (S-1843): a switch of model or prompt asks again.
const failedAt = (key: string, cfg: string) => `${key}\u0000${cfg}`;
const keyOf = (agent: string, id: string, hash: string) => `${agent}\u0000${id}\u0000${hash}`;
// The sha256 of a call's name and input: a summary is stored for, and read back by, this.
export function callHash(call: ToolCallIn): string {
  return createHash('sha256').update(`${call.name}\u0000${JSON.stringify(call.input ?? null)}`, 'utf8').digest('hex');
}

// The config, read on every use (settings() costs one stat while the file is unchanged), so a
// hand edit of settings.json counts too. A write through stam also tells refresh: turned off,
// nothing queued runs and calls in flight stop.
let listening = false;
function current(): ToolSummaryConfig {
  if (!listening) {
    listening = true;
    onSettingsChange(refresh);
  }
  return toolSummaryConfig(settings());
}
// The step is on with its toggle and a model; an empty model turns it off (S-1843).
const stepOn = (c: ToolSummaryConfig) => c.enabled && c.model !== '';
function refresh(): void {
  if (stepOn(current())) return;
  for (const j of queue.splice(0)) drop(j);
  for (const c of inFlight) c.abort();
}
function drop(j: Job): void {
  jobs.delete(j.key);
  j.finish();
}

// The summaries for a batch of an agent's calls, in priority order (the first is asked first).
// Stored ones come back at once; missing and stale ones (S-1843) are queued ahead of older batches,
// and the answer waits up to `waitMs` for them. A call still unanswered then is listed in `pending`
// (a stale one until its new summary lands); one that
// failed is in neither, so the view shows it raw, and so is one that can't be asked now (no key,
// or the system budget spent).
export async function toolSummaries(agent: string, calls: ToolCallIn[], waitMs = 0): Promise<ToolSummaries> {
  const c = current();
  const on = stepOn(c);
  const cfg = configHash(c.model, c.instructions, c.maxWords);
  const summaries: Record<string, ToolSummary> = {};
  const asked: Job[] = [];
  const seen = new Set<string>();
  const canAsk = on && !!apiKey() && !systemHeld();
  for (const call of calls.slice(0, BATCH_MAX)) {
    if (seen.has(call.id)) continue;
    seen.add(call.id);
    const hash = callHash(call);
    const stored = db.getToolSummary(agent, call.id, hash);
    const key = keyOf(agent, call.id, hash);
    if (stored) summaries[call.id] = shown(stored);
    // A stored summary with another model or prompt hash (or none) is stale: it shows until the new one
    // lands. With the step off, nothing is asked.
    if (stored && (!canAsk || stored.configHash === cfg)) continue;
    if (canAsk && !failed.has(failedAt(key, cfg))) asked.push(jobs.get(key) ?? job(agent, call, hash, c, cfg));
  }
  promote(asked);
  if (waitMs > 0 && asked.length) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(asked.map((j) => j.done)), new Promise<void>((r) => (timer = setTimeout(r, Math.min(waitMs, WAIT_MAX_MS))))]);
    clearTimeout(timer);
  }
  const pending: string[] = [];
  // A call dropped off the queue (or by the step turning off) is still pending: the next request
  // queues it again. A stale one stays pending until its new summary lands, so the view asks again.
  for (const j of asked) {
    const stored = db.getToolSummary(agent, j.call.id, j.hash);
    if (stored) summaries[j.call.id] = shown(stored);
    if (stored?.configHash === cfg) continue;
    if (!failed.has(failedAt(j.key, cfg))) pending.push(j.call.id);
  }
  return { enabled: on, summaries, pending };
}

const shown = (s: { tool: string; doing: string }): ToolSummary => ({ tool: s.tool, doing: s.doing });

function job(agent: string, call: ToolCallIn, hash: string, config: ToolSummaryConfig, cfg: string): Job {
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const j: Job = { key: keyOf(agent, call.id, hash), agent, call, hash, config, cfg, running: false, done, finish };
  jobs.set(j.key, j);
  return j;
}

// The batch's waiting calls move to the queue's front in the batch's order; what falls past the
// end is dropped, to be asked again when the view shows it.
function promote(batch: Job[]): void {
  const front = batch.filter((j) => !j.running);
  if (!front.length) return;
  const rest = queue.filter((j) => !front.includes(j));
  queue.splice(0, queue.length, ...front, ...rest);
  for (const j of queue.splice(QUEUE_MAX)) drop(j);
  if (pumpSoon) return;
  pumpSoon = true;
  setImmediate(() => {
    pumpSoon = false;
    pump();
  });
}
let pumpSoon = false;

function pump(): void {
  while (inFlight.size < CONCURRENCY && queue.length && stepOn(current())) {
    const j = queue.shift()!;
    j.running = true;
    const ctl = new AbortController();
    inFlight.add(ctl);
    void summarize(j, ctl.signal)
      .catch(() => {})
      .finally(() => {
        inFlight.delete(ctl);
        drop(j);
        pump();
      });
  }
}

async function summarize(j: Job, signal: AbortSignal): Promise<void> {
  const c = j.config;
  const key = apiKey();
  // A spent system budget or no OpenRouter key: nothing is asked, and not remembered as failed,
  // so a fixed key or a new budget window summarises the call on a later request.
  if (systemHeld() || !key) return;
  let data: any;
  try {
    const res = await fetch(`${base()}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: c.model,
        messages: [
          { role: 'system', content: c.instructions },
          { role: 'user', content: callText(j.call) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'tool_summary',
            strict: true,
            schema: {
              type: 'object',
              properties: { tool: { type: 'string', description: TOOL_SUMMARY_FIELDS.tool }, doing: { type: 'string', description: TOOL_SUMMARY_FIELDS.doing } },
              required: ['tool', 'doing'],
              additionalProperties: false,
            },
          },
        },
        max_tokens: 80,
        temperature: 0,
        usage: { include: true },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    const canceled = signal.aborted;
    // A canceled call was turned off, not failed; it is asked again once the step is back on.
    if (!canceled) failed.add(failedAt(j.key, j.cfg));
    db.addEvent('stam', canceled ? 'tool-summary:canceled' : 'tool-summary:error', { agent: j.agent, call: j.call.id, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  const usage = data?.usage ?? {};
  const model = String(data?.model ?? c.model);
  recordSpend(PURPOSE, model, Number(usage.cost) || 0, Number(usage.prompt_tokens) || 0, Number(usage.completion_tokens) || 0);
  const s = parseToolSummary(data?.choices?.[0]?.message?.content, c.maxWords);
  if (!s) {
    failed.add(failedAt(j.key, j.cfg));
    db.addEvent('stam', 'tool-summary:refused', { agent: j.agent, call: j.call.id });
    return;
  }
  db.setToolSummary(j.agent, j.call.id, j.hash, s.tool, s.doing, model, j.cfg);
}

// The calls waiting in the queue, first asked first, for tests.
export const queuedCalls = (): string[] => queue.map((j) => j.call.id);

// What the model is told about one call: its tool name and its input, cut to INPUT_CHARS.
export function callText(call: ToolCallIn): string {
  const input = call.input === undefined ? '' : typeof call.input === 'string' ? call.input : JSON.stringify(call.input);
  return `Tool: ${call.name}\nInput: ${input.slice(0, INPUT_CHARS)}`;
}

const words = (s: string) => s.split(' ').filter(Boolean).length;
// The model's answer as a summary: a JSON object (a ```json fence around it is allowed) with
// both fields as text, `tool` at most three words and `doing` at most `maxWords`. Null otherwise.
export function parseToolSummary(raw: unknown, maxWords: number): ToolSummary | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.tool !== 'string' || typeof o.doing !== 'string') return null;
  const tool = o.tool.replace(/\s+/g, ' ').trim();
  const doing = o.doing.replace(/\s+/g, ' ').trim();
  if (!tool || !doing || words(tool) > TOOL_WORDS || words(doing) > maxWords || tool.length > TOOL_CHARS || doing.length > DOING_CHARS) return null;
  return { tool, doing };
}

// A request's calls, checked: each needs an id and a name, both short text. Throws on anything else.
export function readCalls(raw: unknown): ToolCallIn[] {
  if (!Array.isArray(raw)) throw new Error('calls must be a list');
  return raw.map((c) => {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id || c.id.length > ID_CHARS || typeof c.name !== 'string' || !c.name || c.name.length > ID_CHARS) throw new Error('each call needs an id and a name');
    return { id: c.id, name: c.name, input: c.input };
  });
}
