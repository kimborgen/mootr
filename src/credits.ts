// OpenRouter credit balance. OpenCode agents on an OpenRouter model spend credit the
// human tops up by hand, so stam polls the balance while such agents are active, keeps it
// as a subscription-like entry (the Usage view and the usage_info MCP tool show it), and
// mails the human once per top-up when the remaining balance drops below
// cost.openrouterWarnUsd.
import * as db from './db.ts';
import { settings, humanMailAllows } from './settings.ts';
import { render } from './templates.ts';
import { sendMail, HUMAN } from './mail.ts';
import * as costNotices from './cost-notices.ts';
import { onReading } from './rules.ts';
import { reconcile, snapshot } from './reconcile.ts';
import { evaluateBudgets } from './budgets.ts';
import { setCreditPoller } from './credit-poller.ts';
import { openrouter, openRouterKey } from './llm/openrouter.ts';

const POLL_MS = 5 * 60_000;
// A turn ended just now, so the balance just moved: refresh it, but not more often than this.
const TURN_COOLDOWN_MS = 60_000;
let lastPoll = 0;
let polling = false;

// The key OpenCode uses; providerEnv in adapters/opencode.ts reads the same file. Read by the LLM
// layer's OpenRouter adapter (src/llm/openrouter.ts) and exported for the stam model calls that
// check it first.
export const apiKey = openRouterKey;

// An agent that spends OpenRouter credit.
function usesOpenRouter(a: db.Agent): boolean {
  return a.lifecycle === 'active' && a.harness === 'opencode' && (a.model ?? '').startsWith('openrouter/');
}

interface CreditFields {
  total: number | null;
  used: number | null;
  remaining: number | null;
  key_limit: number | null;
  key_remaining: number | null;
  observed_at?: string | null;
}
// The capacity a warning was issued for; a later increase in either field is a top-up.
interface Basis {
  total: number | null;
  key_limit: number | null;
}
interface Entry {
  credits?: CreditFields;
  warned?: Basis | null;
  pending?: boolean;
}

function stored(): Entry | undefined {
  const row = db.open().prepare("SELECT data FROM subscriptions WHERE name = 'openrouter'").get() as { data: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.data) as Entry;
  } catch {
    return undefined;
  }
}

function write(entry: Entry): void {
  db.open()
    .prepare('INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run('openrouter', JSON.stringify(entry), new Date().toISOString());
  void onReading('openrouter', null, entry as Record<string, any>);
  // The agents' scope is held while the credit is down to the system's reserve (budgets.ts).
  void evaluateBudgets('openrouter');
}

// The error probe (cost-probes.ts): GET /key with the key OpenCode uses. True when it answers.
export async function probeKey(): Promise<boolean> {
  const key = apiKey();
  return key != null && (await openrouter.keyLimit!(key)) != null;
}

// One poll at a time. Fetches the account's total credits and usage, and the key's own
// limit when it has one; the remaining balance is the smaller of the two. A missing or
// failed call keeps the last valid figures rather than zeroing them, so an error can never
// make the balance look low (or drop the key's cap).
export async function pollCredits(): Promise<void> {
  if (polling) return;
  const key = apiKey();
  if (!key) return;
  polling = true;
  lastPoll = Date.now();
  try {
    const prev = stored();
    const pending = snapshot(); // before /credits is read: later reports wait for the next poll
    // A failed or non-2xx call (a 401/403 on /credits, say, or a 429/500) is null; the last valid reading is kept.
    const c = await openrouter.balance!(key);
    // The account's billed spend since the last reading corrects the ledger (reconcile.ts),
    // right when /credits returns, so nothing recorded during the /key call is read as billed.
    const billedUsed = c?.used ?? null;
    if (billedUsed != null) reconcile(pending, billedUsed);
    const k = await openrouter.keyLimit!(key);
    const total = c?.total ?? prev?.credits?.total ?? null;
    const used = c?.used ?? prev?.credits?.used ?? null;
    // /key succeeding while its limit is absent means there is no cap: clear it, don't keep it.
    const keyLimit = k ? k.limit : prev?.credits?.key_limit ?? null;
    const keyRemaining = k ? k.remaining : prev?.credits?.key_remaining ?? null;
    const account = total != null && used != null ? total - used : null;
    const remaining = account != null && keyRemaining != null ? Math.min(account, keyRemaining) : account ?? keyRemaining;
    if (remaining == null) return; // nothing valid this time: leave the last entry as it is
    const next = await nextWarning(prev, remaining, total, keyLimit);
    // When the balance was last fetched whole: both calls answered this poll. A partial or
    // failed poll keeps the earlier time, so the cost rules never read old figures as fresh.
    const fetched = c?.total != null && c?.used != null && k != null;
    const observed_at = fetched ? new Date().toISOString() : (prev?.credits?.observed_at ?? null);
    write({ credits: { total, used, remaining, key_limit: keyLimit, key_remaining: keyRemaining, observed_at }, ...next });
  } catch {}
  finally {
    polling = false;
  }
}

// Decides whether to mail the human and what warning state to store. The state rides in
// the entry, so a restart keeps it. A warning re-arms when the balance climbs above the
// threshold or a top-up raises the credit capacity, and a warning that couldn't be sent
// stays pending and is retried on the next poll.
async function nextWarning(prev: Entry | undefined, remaining: number, total: number | null, keyLimit: number | null): Promise<{ warned: Basis | null; pending: boolean }> {
  const threshold = settings().cost.openrouterWarnUsd;
  if (!threshold || remaining >= threshold) return { warned: null, pending: false };
  const warned = prev?.warned ?? null;
  const due = (prev?.pending ?? false) || warned == null || increased(warned, { total, key_limit: keyLimit });
  if (!due) return { warned, pending: false };
  const agents = db.listAgents().filter(usesOpenRouter).map((a) => a.name);
  // The responsible managers hear first; the human only when humanMail.when allows it.
  costNotices.lowCredits(remaining, threshold, `${total}:${keyLimit}`);
  const sent = humanMailAllows('important')
    ? await mailHuman(
        `OpenRouter credit low: $${remaining.toFixed(2)} left`,
        render('credit-warning', { remaining: remaining.toFixed(2), threshold: threshold.toFixed(2), agents: agents.join(', ') || 'none' }),
      )
    : true;
  // Mark the top-up only once the mail is away (or the human chose not to be mailed);
  // otherwise retry it while it is pending.
  return sent ? { warned: { total, key_limit: keyLimit }, pending: false } : { warned, pending: true };
}

function increased(was: Basis, now: Basis): boolean {
  return (was.total != null && now.total != null && now.total > was.total) || (was.key_limit != null && now.key_limit != null && now.key_limit > was.key_limit);
}

// At most one poll every five minutes, while an OpenRouter-backed agent is active or held.
// An agent stam holds for credits-out, or for the system reserve (a budget blocker on openrouter),
// counts too: only a fresh balance clears it.
function pollIfActive(): void {
  const held = (a: db.Agent) => a.harness === 'opencode' && (a.model ?? '').startsWith('openrouter/') && db.blockerRows(a.id).some((b) => b.kind === 'credits-out' || (b.kind === 'budget' && b.account === 'openrouter'));
  if (!db.listAgents().some((a) => usesOpenRouter(a) || held(a))) return;
  if (Date.now() - lastPoll < POLL_MS) return;
  void pollCredits();
}

// The budget reserve asks for a fresh balance when a spawn is refused or the reading is stale, so a
// top-up lifts the hold with no OpenRouter agent running. Not more often than after a turn.
setCreditPoller(() => {
  if (Date.now() - lastPoll >= TURN_COOLDOWN_MS) void pollCredits();
});

// Called after an OpenCode agent's turn ends.
export function pollCreditsAfterTurn(agent: db.Agent): void {
  if (!(agent.model ?? '').startsWith('openrouter/')) return;
  if (Date.now() - lastPoll < TURN_COOLDOWN_MS) return;
  void pollCredits();
}

// Once at daemon start when a key exists, then on the interval.
export function startCreditPolling(): void {
  if (apiKey()) void pollCredits();
  setInterval(pollIfActive, 60_000);
}

// Mail to the human needs a sender; the first running agent stands in, as stam itself has
// no mailbox (mirrors usage.ts). Returns false when there is no sender or sending failed,
// so the caller keeps the warning pending and tries again.
async function mailHuman(subject: string, body: string): Promise<boolean> {
  const sender = db.listAgents().find((a) => a.lifecycle === 'active');
  if (!sender) return false;
  try {
    await sendMail({ from: sender.id, to: [HUMAN], subject: `[stam] ${subject}`, body, from_stam: true });
    return true;
  } catch {
    return false;
  }
}
