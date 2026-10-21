// Tool names (S-1933): the conversation view names a tool call by one stored label per tool, not by
// the raw name or a summary per call. The built-in tools of each harness are seeded in code
// (src/tool-name-labels.ts); any other tool gets a label from a tiny model (Settings › Tiny models ›
// Tool names, on by default) the first time it is shown, stored in stam.db by harness and tool name
// and reused for ever, by every agent of that harness, so a tool is named once however many agents
// and views show it. Lazy: the web asks only for the visible tools that have no label, and nothing is
// asked in bulk or again after a settings change. Every answer of the model, good, partial or empty,
// ends in a stored label or a failure remembered until a restart, never a retry. A tool queued or in
// flight is busy: a second request for it joins the first. For an MCP tool only the tool part is
// named; the server prefix stays as it is. The step is on with its toggle, and asks when the OpenRouter
// key and the system budget allow it; otherwise nothing is asked and the web shows the prettified raw
// name. The same key, stubbable base URL, bounded queue and cost record as src/tool-summaries.ts, the
// cost under openrouter/tool-name.
import * as db from './db.ts';
import { settings, onSettingsChange } from './settings.ts';
import { apiKey } from './credits.ts';
import { recordSpend } from './decide.ts';
import { systemHeld } from './budgets.ts';
import { checkCredential, send } from './llm/http.ts';
import { toolNameConfig, TOOL_NAME_INSTRUCTIONS, TOOL_NAME_MAX_WORDS } from './tiny-models.ts';
import { splitTool, seededLabel } from './tool-name-labels.ts';
import { envVar } from './env.ts';

const base = () => envVar('OPENROUTER_URL') ?? 'https://openrouter.ai/api/v1';
const PURPOSE = 'tool-name';
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 3;
const QUEUE_MAX = 60;
export const NAMES_MAX = 40;
export const NAME_CHARS = 200;
export const WAIT_MAX_MS = 10_000;
const LABEL_WORDS = TOOL_NAME_MAX_WORDS;
const LABEL_CHARS = 30;

// What the web gets back: the label of each named tool that has one (seeded or stored), and the tools still
// being named. Disabled, nothing is asked: seeded and stored labels still come back.
export interface ToolNames { enabled: boolean; labels: Record<string, string>; pending: string[] }

type Job = { key: string; harness: string; tool: string; model: string; running: boolean; done: Promise<void>; finish: () => void };
const queue: Job[] = [];
// Queued or in flight, by harness and tool: a tool is named once at a time.
const jobs = new Map<string, Job>();
const inFlight = new Set<AbortController>();
// Tools whose answer failed or was refused since this process started.
const failed = new Set<string>();
const keyOf = (harness: string, tool: string) => `${harness}\u0000${tool}`;

let listening = false;
// The model the step asks, '' while the step is off (its toggle in Settings › Tiny models).
function model(): string {
  if (!listening) {
    listening = true;
    onSettingsChange(refresh);
  }
  const c = toolNameConfig(settings());
  return c.enabled ? c.model : '';
}
function refresh(): void {
  if (model() !== '') return;
  for (const j of queue.splice(0)) drop(j);
  for (const c of inFlight) c.abort();
}
function drop(j: Job): void {
  jobs.delete(j.key);
  j.finish();
}

// The label for each of an agent's tools (raw names, the first asked first). Seeded and stored labels
// come back at once; a missing one is queued and the answer waits up to `waitMs` for it. A tool still
// unnamed then is `pending`; one that failed is in neither, so the view shows its prettified name.
export async function toolNames(harness: string, names: string[], waitMs = 0): Promise<ToolNames> {
  const m = model();
  const enabled = m !== '' && !!apiKey() && !systemHeld();
  const labels: Record<string, string> = {};
  const asked: Job[] = [];
  const seenTool = new Set<string>();
  for (const name of names.slice(0, NAMES_MAX)) {
    const { tool } = splitTool(name, harness);
    const have = seededLabel(harness, tool) ?? db.getToolName(harness, tool);
    if (have) {
      labels[name] = have;
      continue;
    }
    if (!enabled || seenTool.has(tool) || failed.has(keyOf(harness, tool))) continue;
    seenTool.add(tool);
    asked.push(jobs.get(keyOf(harness, tool)) ?? job(harness, tool, m));
  }
  promote(asked);
  if (waitMs > 0 && asked.length) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(asked.map((j) => j.done)), new Promise<void>((r) => (timer = setTimeout(r, Math.min(waitMs, WAIT_MAX_MS))))]);
    clearTimeout(timer);
  }
  const pending: string[] = [];
  for (const name of names.slice(0, NAMES_MAX)) {
    if (labels[name]) continue;
    const { tool } = splitTool(name, harness);
    const stored = db.getToolName(harness, tool);
    if (stored) labels[name] = stored;
    else if (enabled && !failed.has(keyOf(harness, tool))) pending.push(name);
  }
  return { enabled, labels, pending };
}

function job(harness: string, tool: string, m: string): Job {
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const j: Job = { key: keyOf(harness, tool), harness, tool, model: m, running: false, done, finish };
  jobs.set(j.key, j);
  return j;
}

// A batch's waiting tools move to the queue's front; what falls past the end is dropped, to be asked
// again when the view shows it.
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
  while (inFlight.size < CONCURRENCY && queue.length && model() !== '') {
    const j = queue.shift()!;
    j.running = true;
    const ctl = new AbortController();
    inFlight.add(ctl);
    void name(j, ctl.signal)
      .catch(() => {})
      .finally(() => {
        inFlight.delete(ctl);
        drop(j);
        pump();
      });
  }
}

async function name(j: Job, signal: AbortSignal): Promise<void> {
  const key = apiKey();
  // A spent system budget or no key: nothing is asked, and not remembered as failed.
  if (systemHeld() || !key) return;
  let data: any;
  try {
    // checkCredential refuses a key that isn't a plain header value, with text that names no key (S-2117).
    const res = await send(`${base()}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${checkCredential(key, 'API key')}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: j.model,
        messages: [
          { role: 'system', content: TOOL_NAME_INSTRUCTIONS },
          { role: 'user', content: `Tool: ${j.tool}` },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'tool_name',
            strict: true,
            schema: { type: 'object', properties: { label: { type: 'string', description: 'the tool in plain English, 1-3 words' } }, required: ['label'], additionalProperties: false },
          },
        },
        max_tokens: 30,
        temperature: 0,
        usage: { include: true },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    const canceled = signal.aborted;
    // A canceled call was turned off, not failed; it is asked again once a model is back.
    if (!canceled) failed.add(j.key);
    db.addEvent('stam', canceled ? 'tool-name:canceled' : 'tool-name:error', { harness: j.harness, tool: j.tool, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  const usage = data?.usage ?? {};
  const used = String(data?.model ?? j.model);
  recordSpend(PURPOSE, used, Number(usage.cost) || 0, Number(usage.prompt_tokens) || 0, Number(usage.completion_tokens) || 0);
  const label = parseToolLabel(data?.choices?.[0]?.message?.content);
  if (!label) {
    failed.add(j.key);
    db.addEvent('stam', 'tool-name:refused', { harness: j.harness, tool: j.tool });
    return;
  }
  db.setToolName(j.harness, j.tool, label, used);
}

// The tools waiting in the queue, first asked first, for tests.
export const queuedTools = (): string[] => queue.map((j) => j.tool);

const words = (s: string) => s.split(' ').filter(Boolean).length;
// The model's answer as a label: a JSON object (a ```json fence around it is allowed) with a `label`
// of at most three words. Null for anything else: empty, not JSON, no label, or too long.
export function parseToolLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  let o: any;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.label !== 'string') return null;
  const label = o.label.replace(/\s+/g, ' ').trim();
  if (!label || words(label) > LABEL_WORDS || label.length > LABEL_CHARS) return null;
  return label;
}

// A request's tool names, checked: each is short text. Throws on anything else.
export function readNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('names must be a list');
  return raw.map((n) => {
    if (typeof n !== 'string' || !n || n.length > NAME_CHARS) throw new Error('each name must be text, at most 200 characters');
    return n;
  });
}
