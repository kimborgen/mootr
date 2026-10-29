// A decision model: one cheap call to a small model that answers a fixed question about a
// piece of state, without a full language-model turn. The first use is the mail check
// (src/mail-check.ts): does a mail to the human follow the rules for mailing the human?
//
// The call (src/llm/openrouter.ts) is Microsoft's decision model through OpenRouter:
//   POST https://openrouter.ai/api/alpha/decisions
//   {"model": id, "state": <string|object|array>, "questions": {"<name>": <question>}}
//   -> {"model": id, "answers": {"<name>": <answer>}, "usage": {...}, "id": ..., "provider": ...}
// Question types (probed live 2026-10-11 against microsoft/microsoft-decision-1):
//   "noul"   {"type":"noul","instructions":"..."} -> answers[name].noul, P(yes), 0..1
//   "choice" {"type":"choice","instructions":"...","criteria":{"<key>":"<description>"}}
//            -> answers[name].choice (the picked key), .probabilities (key -> probability),
//               .confidence
//   "score"  {"type":"score","instructions":"...","criteria":["<label>", ...]}
//            -> answers[name].score (0..1), .legend (index -> label), .probabilities, .confidence
//
// The key is the same file src/credits.ts reads; the endpoint is overridable with
// STAM_OPENROUTER_URL so a test can stub it. The model id comes from settings.decisions.model.
// A provider without the decisions endpoint (anything but OpenRouter: `myazure:gpt-4o`) is asked the
// same questions through its chat completion instead, with a JSON schema that has one object per
// question, and the answer is parsed into the shape above (askByCompletion).
// The cost is recorded in stam's usage under the openrouter-system account, attributed to stam
// itself with the purpose as the model, so it shows on the Usage page. A model on another provider books
// to <provider>-system instead (S-3245). When that account's budget (cost.accounts.openrouter-system.budget for
// OpenRouter) is spent, decide fails without a call. A failure never
// throws into a caller's path: decide returns null and records a `decide:error` event.
import * as db from './db.ts';
import { ledgerChanged, providerHeld } from './budgets.ts';
import { spendTo } from './tiny-spend.ts';
import { settings, SYSTEM_ACCOUNT } from './settings.ts';
import { addExactPending } from './reconcile.ts';
import { LlmHttpError, complete, resolve } from './llm/index.ts';

const TIMEOUT_MS = 20_000;

export type Question =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface DecisionResult {
  model: string;
  // One entry per question name, shaped by the question's type (see the file header).
  answers: Record<string, any>;
  usage: { input_tokens?: number; output_tokens?: number; cost?: number };
}

// A noul question's probability, or null when the answer is missing or outside 0..1.
export function noul(result: DecisionResult | null, name: string): number | null {
  const v = result?.answers?.[name]?.noul;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

// Why a call failed. `kind` tells a rate limit (429) or a server error (5xx), which a caller may
// retry, from anything else (no key, a network error, a timeout, a bad body). `retryAfterMs` is the
// Retry-After header in milliseconds, when the response gave one (capped at 5 minutes).
export interface DecideFailure {
  kind: 'rate-limit' | 'server' | 'other';
  status?: number;
  retryAfterMs?: number;
  error: string;
}

// Asks the decision model and says why it failed. Returns the answers and no failure, or null and
// the failure (no key, a network or HTTP error, a timeout, or a body without answers), with an
// event either way. `purpose` names what the call is for (e.g. "decide:mail-check"); it is recorded
// with the cost. Never throws.
export async function decideWithFailure(
  state: string | Record<string, unknown> | unknown[],
  questions: Record<string, Question>,
  opts: { purpose: string; timeoutMs?: number },
): Promise<{ result: DecisionResult; failure: null } | { result: null; failure: DecideFailure }> {
  const { adapter, model } = resolve(settings().decisions.model);
  // One read of the key: the call below uses this snapshot, not a second read.
  const key = adapter.apiKey();
  if (!key && !adapter.keyless) return { result: null, failure: { kind: 'other', error: 'no API key' } };
  const held = providerHeld(adapter.id);
  if (held) return { result: null, failure: fail(opts.purpose, { kind: 'other', error: held }) };
  let data: any;
  try {
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    data = adapter.decisions
      ? await adapter.decisions({ model, state, questions }, { timeoutMs, key })
      : await askByCompletion(settings().decisions.model, state, questions, timeoutMs);
  } catch (e) {
    if (e instanceof LlmHttpError) {
      const kind = e.status === 429 ? 'rate-limit' : e.status >= 500 ? 'server' : 'other';
      return { result: null, failure: fail(opts.purpose, { kind, status: e.status, retryAfterMs: e.retryAfterMs, error: e.message }) };
    }
    return { result: null, failure: fail(opts.purpose, { kind: 'other', error: e instanceof Error ? e.message : String(e) }) };
  }
  if (!data?.answers || typeof data.answers !== 'object') {
    return { result: null, failure: fail(opts.purpose, { kind: 'other', error: 'no answers in the response' }) };
  }
  const usage = data.usage ?? {};
  recordSpend(opts.purpose, String(data.model ?? model), Number(usage.cost) || 0, Number(usage.input_tokens) || 0, Number(usage.output_tokens) || 0, spendTo(adapter.id));
  return { result: { model: String(data.model ?? model), answers: data.answers, usage }, failure: null };
}

// The decisions answer for a provider that has no decisions endpoint: one completion with a JSON
// schema asking for an object per question, parsed back into the endpoint's answer shape. A question
// whose answer is missing or out of range is left out; a body with no valid answer is null.
async function askByCompletion(ref: string, state: string | Record<string, unknown> | unknown[], questions: Record<string, Question>, timeoutMs: number): Promise<any> {
  const properties: Record<string, unknown> = {};
  const lines: string[] = [];
  for (const [name, q] of Object.entries(questions)) {
    const num = { type: 'number' };
    if (q.type === 'noul') {
      properties[name] = objectSchema({ noul: num });
      lines.push(`- ${name} (noul): ${q.instructions}\n  Answer {"noul": P} with P the probability from 0 to 1 that the answer is yes.`);
    } else if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      properties[name] = objectSchema({ choice: { type: 'string', enum: keys }, probabilities: objectSchema(Object.fromEntries(keys.map((k) => [k, num]))), confidence: num });
      lines.push(`- ${name} (choice): ${q.instructions}\n  Answer with "choice" (one key), "probabilities" (each key's probability from 0 to 1, summing to 1) and "confidence" (0 to 1). Keys:\n${keys.map((k) => `    ${k}: ${q.criteria[k]}`).join('\n')}`);
    } else {
      properties[name] = objectSchema({ score: num, confidence: num });
      lines.push(`- ${name} (score): ${q.instructions}\n  Answer with "score" (0 to 1: ${q.criteria.map((c, i) => `${i} is ${c}`).join(', ')}) and "confidence" (0 to 1).`);
    }
  }
  const r = await complete({
    model: ref,
    messages: [
      { role: 'system', content: 'You answer questions about a piece of state. Reply with one JSON object that has one entry per question name and nothing else.' },
      { role: 'user', content: `State:\n${typeof state === 'string' ? state : JSON.stringify(state)}\n\nQuestions:\n${lines.join('\n')}` },
    ],
    maxTokens: 1000,
    jsonSchema: { name: 'decisions', schema: objectSchema(properties) },
    timeoutMs,
  });
  const raw = r.json as Record<string, any> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const answers: Record<string, any> = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = parseAnswer(q, raw[name]);
    if (a) answers[name] = a;
  }
  if (!Object.keys(answers).length) return null;
  return { model: r.model, answers, usage: { input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens, cost: r.costUsd ?? 0 } };
}

const objectSchema = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

function parseAnswer(q: Question, v: any): Record<string, unknown> | null {
  if (!v || typeof v !== 'object') return null;
  const confidence = unit(v.confidence) ? v.confidence : undefined;
  if (q.type === 'noul') return unit(v.noul) ? { type: 'noul', noul: v.noul } : null;
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria);
    if (!keys.includes(v.choice)) return null;
    // Every key needs a probability and they must sum to 1: a malformed distribution is no answer.
    const ps = keys.map((k) => v.probabilities?.[k]);
    if (!ps.every(unit) || Math.abs(ps.reduce((a, b) => a + b, 0) - 1) > 0.05) return null;
    const probabilities = Object.fromEntries(keys.map((k, i) => [k, ps[i]]));
    return { type: 'choice', choice: v.choice, probabilities, ...(confidence != null ? { confidence } : {}) };
  }
  if (!unit(v.score)) return null;
  return { type: 'score', score: v.score, legend: Object.fromEntries(q.criteria.map((c, i) => [i, c])), probabilities: { 0: 1 - v.score, 1: v.score }, ...(confidence != null ? { confidence } : {}) };
}

// Asks the decision model. Returns the answers, or null on any failure (see decideWithFailure).
export async function decide(
  state: string | Record<string, unknown> | unknown[],
  questions: Record<string, Question>,
  opts: { purpose: string; timeoutMs?: number },
): Promise<DecisionResult | null> {
  return (await decideWithFailure(state, questions, opts)).result;
}

// One recorded failure: never thrown, only logged.
function fail(purpose: string, failure: DecideFailure): DecideFailure {
  db.addEvent('stam', 'decide:error', { purpose, error: failure.error, ...(failure.status ? { status: failure.status } : {}) });
  return failure;
}

// Records one model call stam made for itself (a decide call, a mail title): the usage row and
// a `decide` event. The tokens ride along so the Usage By model view can split stam's spend by
// purpose from these events (usage.ts decideSpend); the usage row keeps only the last purpose.
// `to` names the provider and account that served the call; the default is OpenRouter's system account
// (S-3228: a call through another provider books there, not to the OpenRouter credit).
export interface SpendTo { provider: string; account: string }
export function recordSpend(purpose: string, model: string, cost: number, tokensIn: number, tokensOut: number, to?: SpendTo): void {
  const at = to ?? { provider: 'openrouter', account: SYSTEM_ACCOUNT };
  recordCost(purpose, cost, tokensIn, tokensOut, at);
  db.addEvent('stam', 'decide', { purpose, model, cost, tokens_in: tokensIn, tokens_out: tokensOut, ...(to ? { provider: to.provider, account: to.account } : {}) });
}

// Stam's own spend for one decide call: a usage row for the pseudo-agent `stam` on the
// openrouter-system account, with the purpose as the model, so the Usage view shows it under By
// agent (stam) and By model (openrouter/<purpose>). Same-day calls for one purpose add up.
function recordCost(purpose: string, cost: number, tokensIn: number, tokensOut: number, to: SpendTo): void {
  db.open()
    .prepare(
      `INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out)
       VALUES ('stam', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, day, account) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd,
         tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out, model = excluded.model`,
    )
    .run(new Date().toISOString().slice(0, 10), to.provider, purpose, to.account, cost, tokensIn, tokensOut);
  // The response's own cost is billed money: reconcile.ts takes it out of the bill before it scales OpenCode's.
  if (to.provider === 'openrouter') addExactPending(cost);
  // Stam's own calls count against the global budget (and the system account's).
  if (cost > 0) ledgerChanged();
}
