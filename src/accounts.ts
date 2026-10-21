// Cost accounts: which provider login or key an agent bills to (docs/cost-policy.md).
// Build step 2 is config only: matching and validation, no gating or stops. An agent that
// matches no account is unmanaged and keeps today's behaviour.
import { registry } from './registry.ts';
import * as db from './db.ts';
import { render } from './templates.ts';
import { displayProblem } from './cost-display.ts';
import { sendMail, HUMAN } from './mail.ts';
import { settings, SYSTEM_ACCOUNT, type CostAccount, type CostConfig } from './settings.ts';

// The actions a policy may name (docs/cost-policy.md), strictest first.
const ACTIONS = ['continue', 'soft-stop', 'hard-stop', 'wait', 'take-over'];

// Prints a value in an error message without ever throwing, however malformed it is.
function show(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return '<unprintable>';
  }
}

// The account whose match covers this harness and model, or null for unmanaged. A model
// prefix matches a model that starts with it; the longest prefix wins.
export function matchAccount(cost: CostConfig, harness: string, model: string | null): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const [name, acct] of Object.entries(cost.accounts ?? {})) {
    const m = acct?.match;
    if (!m || m.harness !== harness) continue;
    if (m.model != null && !(model ?? '').startsWith(m.model)) continue;
    const len = m.model?.length ?? 0;
    if (len > bestLen) {
      best = name;
      bestLen = len;
    }
  }
  return best;
}

// The account an agent bills to, or null when it matches none.
export function accountFor(a: { harness: string; model?: string | null }): string | null {
  return matchAccount(settings().cost, a.harness, a.model ?? null);
}

// A take-over target names an account, a preset, or a harness; resolve it to an account
// name, or null when it names nothing that matches one.
export function resolveTarget(cost: CostConfig, name: string): string | null {
  const accounts = cost.accounts ?? {};
  if (Object.hasOwn(accounts, name)) return name;
  const r = registry();
  const p = r.presets?.[name];
  if (p) return matchAccount(cost, p.harness, p.model ?? null);
  if (r.harnesses?.[name]) return matchAccount(cost, name, null);
  return null;
}

// Two matches overlap when some harness and model would bill to both.
function overlaps(a: { harness: string; model?: string }, b: { harness: string; model?: string }): boolean {
  if (a.harness !== b.harness) return false;
  if (a.model == null || b.model == null) return true; // a harness-only match covers every model
  return a.model.startsWith(b.model) || b.model.startsWith(a.model);
}

// The take-over targets an action names, whether the action is a name or an object.
function targets(action: unknown): string[] {
  if (action && typeof action === 'object' && Array.isArray((action as { to?: unknown }).to)) {
    return (action as { to: unknown[] }).to.filter((t): t is string => typeof t === 'string');
  }
  return [];
}

// The action names an action field uses: its own, and its else.
function actionNames(action: unknown): string[] {
  if (typeof action === 'string') return [action];
  if (!action || typeof action !== 'object') return [];
  const a = action as { action?: unknown; else?: unknown };
  return [a.action, a.else].filter((x): x is string => typeof x === 'string');
}

// The action an account's field takes effect with: its own, or for onError the inherited
// cost.onError. `inherited` marks the latter.
function effective(cost: CostConfig, name: string, field: (typeof ACTION_FIELDS)[number]): { action: unknown; inherited: boolean } {
  const own = cost.accounts[name]?.[field];
  if (own == null && field === 'onError' && cost.onError != null) return { action: cost.onError, inherited: true };
  return { action: own, inherited: false };
}

// Checks one action field: a known name, or take-over whose targets resolve to other accounts.
// An inherited cost.onError may name the account itself; the fallback skips that target there.
function checkAction(where: string, action: unknown, cost: CostConfig, from: string | null, inherited = false): string | null {
  if (action == null) return null;
  if (typeof action === 'string') return ACTIONS.includes(action) ? null : `${where}: unknown action ${action}`;
  if (typeof action !== 'object') return `${where}: action must be a name or an object`;
  const a = action as { action?: unknown; else?: unknown; to?: unknown };
  if (typeof a.action !== 'string' || !ACTIONS.includes(a.action)) return `${where}: unknown action ${JSON.stringify(a.action)}`;
  if (a.else != null && (typeof a.else !== 'string' || !ACTIONS.includes(a.else))) return `${where}: unknown else action ${JSON.stringify(a.else)}`;
  if (a.to != null && (!Array.isArray(a.to) || a.to.some((t) => typeof t !== 'string'))) return `${where}: to must be a list of names`;
  for (const t of targets(action)) {
    const to = resolveTarget(cost, t);
    if (!to) return `${where}: ${t} matches no account`;
    if (from && to === from && !inherited) return `${where}: ${t} resolves to ${to}, the same account`;
  }
  return null;
}

// The account fields that carry an action.
export const ACTION_FIELDS = ['onSubExhausted', 'onBudgetExhausted', 'onCreditsOut', 'onBillingUnknown', 'onError'] as const;

// The take-over edges out of an account: the accounts its effective actions, the inherited
// cost.onError included, can move work to. An inherited self-target is skipped, as at run time.
function edges(cost: CostConfig, name: string): string[] {
  const out = new Set<string>();
  for (const field of ACTION_FIELDS) {
    const { action, inherited } = effective(cost, name, field);
    for (const t of targets(action)) {
      const to = resolveTarget(cost, t);
      if (to && !(inherited && to === name)) out.add(to);
    }
  }
  return [...out];
}

// The take-over cycle between accounts, or null when the graph is acyclic.
function findCycle(cost: CostConfig): string[] | null {
  const accounts = cost.accounts ?? {};
  const state = new Map<string, number>(); // 0 unvisited, 1 on the stack, 2 done
  const stack: string[] = [];
  const visit = (name: string): string[] | null => {
    state.set(name, 1);
    stack.push(name);
    for (const to of edges(cost, name)) {
      if (!Object.hasOwn(accounts, to)) continue;
      const s = state.get(to) ?? 0;
      if (s === 1) return [...stack.slice(stack.indexOf(to)), to];
      if (s === 0) {
        const found = visit(to);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(name, 2);
    return null;
  };
  for (const name of Object.keys(accounts)) {
    if ((state.get(name) ?? 0) === 0) {
      const found = visit(name);
      if (found) return found;
    }
  }
  return null;
}

// Checks a cost config; returns the first problem as a sentence, or null when it is valid.
// Never throws: a malformed value is reported, not formatted into a crash.
export function validate(cost: CostConfig): string | null {
  if (!cost || typeof cost !== 'object') return 'cost must be an object';
  if (cost.instructions != null && typeof cost.instructions !== 'string') return 'cost.instructions must be a string';
  if (cost.fallbackMinutes != null && (typeof cost.fallbackMinutes !== 'number' || !Number.isFinite(cost.fallbackMinutes) || cost.fallbackMinutes <= 0))
    return 'cost.fallbackMinutes must be a positive number';
  if (cost.softStopMinutes != null && (typeof cost.softStopMinutes !== 'number' || !Number.isFinite(cost.softStopMinutes) || cost.softStopMinutes < 0))
    return 'cost.softStopMinutes must be a number of minutes, 0 or more';
  const display = displayProblem((cost as { display?: unknown }).display);
  if (display) return display;
  const accounts = cost.accounts ?? {};
  const names = Object.keys(accounts);
  for (const name of names) {
    const m = accounts[name]?.match;
    if (!m || typeof m.harness !== 'string' || !m.harness) return `account ${name} has no match.harness`;
    if (m.model != null && typeof m.model !== 'string') return `account ${name} has a bad match.model`;
    const provider = accounts[name]?.provider;
    if (provider != null && (typeof provider !== 'string' || !provider)) return `account ${name} has a bad provider`;
  }
  // Each harness and model matches at most one account.
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (overlaps(accounts[names[i]].match, accounts[names[j]].match)) {
        return `accounts ${names[i]} and ${names[j]} both match the same harness and model`;
      }
    }
  }
  // Actions are known names, and every take-over target resolves to another account.
  // `continue` spends past the limit, so only an account with `paid: true` may name it.
  for (const name of names) {
    for (const field of ACTION_FIELDS) {
      const { action, inherited } = effective(cost, name, field);
      const where = inherited ? `onError (inherited by ${name})` : `${name}.${field}`;
      const problem = checkAction(where, action, cost, name, inherited);
      if (problem) return problem;
      if (accounts[name].paid !== true && actionNames(action).includes('continue'))
        return `${where}: continue needs paid: true on ${name}, since it spends past the limit`;
    }
  }
  if (cost.global) {
    if (cost.global.onExhausted != null && !ACTIONS.includes(cost.global.onExhausted)) return `global.onExhausted: unknown action ${show(cost.global.onExhausted)}`;
    if (cost.global.subscriptionWork != null && !['continue', 'stop'].includes(cost.global.subscriptionWork)) return 'global.subscriptionWork must be continue or stop';
  }
  const onError = checkAction('onError', cost.onError, cost, null);
  if (onError) return onError;
  const cycle = findCycle(cost);
  if (cycle) return `take-over cycle: ${cycle.join(' -> ')}`;
  return null;
}

// The last error delivered, and the one still waiting for a sender. A config that stays
// invalid mails the human once per distinct error; the mail is kept until it is delivered.
let sent: string | null = null;
let pending: string | null = null;
let inFlight = false;

// Mails the human the validation error, once per distinct one, with the first running agent
// as the stand-in sender: stam itself has no mailbox, as in usage.ts. With no sender yet the
// mail stays pending and the next call retries; a failed send is retried the same way.
export function noteInvalid(error: string): void {
  if (error !== sent && error !== pending) pending = error;
  deliver();
}

// Retries a notice that is still waiting for a sender or a successful send (settings.ts calls it on a cache hit).
export function retryNotices(): void {
  deliver();
}

function deliver(): void {
  if (!pending || inFlight) return;
  const sender = db.listAgents().find((a) => a.lifecycle === 'active');
  if (!sender) return;
  const error = pending;
  inFlight = true;
  sendMail({ from: sender.id, to: [HUMAN], subject: '[stam] Cost config rejected', body: render('cost-config-rejected', { error }), new_thread: true, from_stam: true })
    .then(() => {
      inFlight = false;
      if (pending === error) {
        pending = null;
        sent = error;
      }
    })
    .catch(() => {
      inFlight = false; // keep it pending; the next call retries
    });
}

// The account stam's own model calls (mail gate, summaries, decisions) bill to. It is billed by
// OpenRouter like `openrouter`, but its budget is the system's, apart from the agents' on `openrouter`.
// A user who wants a system budget configures it with a match no agent has, for example
// { "match": { "harness": "stam" }, "budget": { ... } }.
export { SYSTEM_ACCOUNT };

// An account that bills to the OpenRouter credit: OpenCode on an openrouter/ model, the
// account named `openrouter`, or the system account that the decision model (decide.ts) bills to.
export function isOpenRouter(acct: CostAccount, name: string): boolean {
  if (name === SYSTEM_ACCOUNT) return true;
  return acct.match.harness === 'opencode' && ((acct.match.model ?? '').startsWith('openrouter/') || name === 'openrouter');
}

// The names of every OpenRouter account, whatever the user called them.
export function openRouterAccounts(): string[] {
  const names = Object.entries(settings().cost.accounts ?? {}).filter(([n, a]) => isOpenRouter(a, n)).map(([n]) => n);
  for (const n of ['openrouter', SYSTEM_ACCOUNT]) if (!names.includes(n)) names.push(n);
  return names;
}

// The provider an account pays per token (S-2118), or null for a subscription or unmanaged one:
// `openrouter` for an OpenRouter account, the account's own `provider`, or for OpenCode the
// configured provider its match.model names as `ID/`.
export function payPerTokenProvider(acct: CostAccount, name: string, providers: Record<string, unknown> = settings().providers): string | null {
  if (isOpenRouter(acct, name)) return 'openrouter';
  if (typeof acct.provider === 'string' && acct.provider) return acct.provider;
  const prefix = acct.match.harness === 'opencode' ? (acct.match.model ?? '').split('/')[0] : '';
  return prefix && (acct.match.model ?? '').includes('/') && Object.hasOwn(providers ?? {}, prefix) ? prefix : null;
}
