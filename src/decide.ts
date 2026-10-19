// A decision model: one cheap call to a small model that answers a fixed question about a
// piece of state, without a full language-model turn. The first use is the mail check
// (src/mail-check.ts): does a mail to the human follow the rules for mailing the human?
//
// The call is Microsoft's decision model through OpenRouter:
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
// The cost is recorded in stam's usage under the openrouter-system account, attributed to stam
// itself with the purpose as the model, so it shows on the Usage page. When the system budget
// (cost.accounts.openrouter-system.budget) is spent, decide fails without a call. A failure never
// throws into a caller's path: decide returns null and records a `decide:error` event.
import * as db from './db.ts';
import { ledgerChanged, systemHeld } from './budgets.ts';
import { settings, SYSTEM_ACCOUNT } from './settings.ts';
import { apiKey } from './credits.ts';
import { addExactPending } from './reconcile.ts';

// The decision endpoint's base; credits.ts overrides its own with the same variable.
const base = () => process.env.STAM_OPENROUTER_URL ?? 'https://openrouter.ai/api/alpha';
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

const RETRY_AFTER_MAX_MS = 300_000;

// The Retry-After header as milliseconds: seconds, or an HTTP date. Undefined when absent or unreadable.
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, ms));
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
  const key = apiKey();
  if (!key) return { result: null, failure: { kind: 'other', error: 'no API key' } };
  const held = systemHeld();
  if (held) return { result: null, failure: fail(opts.purpose, { kind: 'other', error: held }) };
  const model = settings().decisions.model;
  let res: Response;
  try {
    res = await fetch(`${base()}/decisions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (e) {
    return { result: null, failure: fail(opts.purpose, { kind: 'other', error: e instanceof Error ? e.message : String(e) }) };
  }
  if (!res.ok) {
    const kind = res.status === 429 ? 'rate-limit' : res.status >= 500 ? 'server' : 'other';
    const retry = retryAfterMs(res.headers.get('retry-after'));
    return { result: null, failure: fail(opts.purpose, { kind, status: res.status, retryAfterMs: retry, error: `HTTP ${res.status}` }) };
  }
  const data = (await res.json().catch(() => null)) as any;
  if (!data?.answers || typeof data.answers !== 'object') {
    return { result: null, failure: fail(opts.purpose, { kind: 'other', error: 'no answers in the response' }) };
  }
  const usage = data.usage ?? {};
  recordSpend(opts.purpose, String(data.model ?? model), Number(usage.cost) || 0, Number(usage.input_tokens) || 0, Number(usage.output_tokens) || 0);
  return { result: { model: String(data.model ?? model), answers: data.answers, usage }, failure: null };
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
export function recordSpend(purpose: string, model: string, cost: number, tokensIn: number, tokensOut: number): void {
  recordCost(purpose, cost, tokensIn, tokensOut);
  db.addEvent('stam', 'decide', { purpose, model, cost, tokens_in: tokensIn, tokens_out: tokensOut });
}

// Stam's own spend for one decide call: a usage row for the pseudo-agent `stam` on the
// openrouter-system account, with the purpose as the model, so the Usage view shows it under By
// agent (stam) and By model (openrouter/<purpose>). Same-day calls for one purpose add up.
function recordCost(purpose: string, cost: number, tokensIn: number, tokensOut: number): void {
  db.open()
    .prepare(
      `INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out)
       VALUES ('stam', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, day, account) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd,
         tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out, model = excluded.model`,
    )
    .run(new Date().toISOString().slice(0, 10), 'openrouter', purpose, SYSTEM_ACCOUNT, cost, tokensIn, tokensOut);
  // The response's own cost is billed money: reconcile.ts takes it out of the bill before it scales OpenCode's.
  addExactPending(cost);
  // Stam's own calls count against the global budget (and the system account's).
  if (cost > 0) ledgerChanged();
}
