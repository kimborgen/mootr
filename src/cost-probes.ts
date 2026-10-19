// Error blockers and probes (docs/cost-policy.md, build step 15, probes part). A provider
// error that ends a turn after the harness's own retries (a `transient` or `auth` signal from
// classifyError) sets `error:ACCOUNT` on every managed agent on the account. Stam then probes
// the account at 1, 2, 4, 8 and 16 minutes, then every 16, one probe per account, and clears
// the blocker on every agent when one succeeds. Claude's credits-out from a billing_error
// clears the same way (rules.ts starts the probe and probeCleared lifts it).
//
// The manager hears the blocker set and cleared through blockers.ts (cost-notices.ts), and its
// onError fallback is armed there (cost-fallback.ts). The human gets one mail per account per
// outage, and only for an `auth` error, which no probe fixes without them; the error
// blocker's clear condition records that it went, so a restart doesn't send it again.
//
// The probe is the cheapest check that proves the account works, with no model turn where
// possible:
//   OpenRouter  GET /key with the key OpenCode uses (credits.probeKey).
//   Codex       account/rateLimits/read through the app-server (codex.probeRateLimits).
//   Claude      the next turn of one blocked agent. Claude has no free endpoint, so stam
//               admits one agent (the one blocked longest that nothing else holds) and keeps
//               the rest held: its blockers stay in place, admission.ts lets the probe agent
//               through, and stam unpauses it. A Stop or a PostToolUse hook from it (the model
//               answered) is success and clears the account; an error signal is failure and
//               re-holds it. A one-token `claude -p` would cost a turn on top of the agent's
//               own and needs its own login and process; the agent's turn is work that runs
//               anyway, and its failure costs what the failed turn would have. A probe turn
//               that shows neither by the next backoff step is abandoned and re-held, and
//               that step probes with another agent.
// Any other harness probes with a turn as Claude does. setProber replaces the probe in tests.
import * as db from './db.ts';
import * as lifecycle from './lifecycle.ts';
import * as blockers from './blockers.ts';
import { settings, humanMailAllows, type CostAccount } from './settings.ts';
import { accountFor } from './accounts.ts';
import { render } from './templates.ts';
import { sendFromStam, HUMAN } from './mail.ts';
import * as rules from './rules.ts';
import { probeKey } from './credits.ts';
import { probeRateLimits } from './adapters/codex.ts';
import type { BlockerKind } from './blockers.ts';

// What a probe found: the account works, it doesn't, or a turn must show it.
export type ProbeOutcome = 'ok' | 'fail' | 'turn';
export type Prober = (account: string, acct: CostAccount) => Promise<ProbeOutcome>;

const MIN = 60_000;
// The wait before probe n (0-based): 1, 2, 4, 8, 16 minutes, then 16.
export const backoff = (n: number) => Math.min(2 ** n, 16) * MIN;

const isOpenRouter = (acct: CostAccount) => acct.match.harness === 'opencode' && (acct.match.model ?? '').startsWith('openrouter/');

async function defaultProber(_account: string, acct: CostAccount): Promise<ProbeOutcome> {
  if (isOpenRouter(acct)) return (await probeKey()) ? 'ok' : 'fail';
  if (acct.match.harness === 'codex') return (await probeRateLimits()) ? 'ok' : 'fail';
  return 'turn';
}
let prober: Prober = defaultProber;
// Tests stub the probe.
export function setProber(p: Prober | null): void {
  prober = p ?? defaultProber;
}

// The blockers a probe clears: error everywhere, credits-out only on Claude (no balance).
function probeKinds(account: string): BlockerKind[] {
  return settings().cost.accounts?.[account]?.match.harness === 'claude' ? ['error', 'credits-out'] : ['error'];
}

interface State {
  attempt: number;
  due: number;
  timer?: ReturnType<typeof setTimeout>;
  // The agent whose turn is the probe, while one runs.
  turn?: string;
}
const states = new Map<string, State>();
// Bumped by every new failure, before anything is queued, and kept when a probe stops: a
// probe's success clears only the generation it tested, so an older success queued behind a
// newer failure leaves that failure's blockers.
const gens = new Map<string, number>();
export const generation = (account: string) => gens.get(account) ?? 0;
// Accounts whose human was mailed this outage, reserved before any await so two auth errors
// at once mail once; the error blocker's clear.human carries it across a restart.
const told = new Set<string>();

// The schedule, for tests and the Usage page: the next probe's attempt and time, and the
// agent whose turn is probing.
export function nextProbe(account: string): { attempt: number; due: number; turn: string | null } | null {
  const s = states.get(account);
  return s ? { attempt: s.attempt, due: s.due, turn: s.turn ?? null } : null;
}

// Whether the agent runs a probe turn for this blocker: admission.ts lets it through.
export function admitsProbe(agentId: string, kind: string, account: string): boolean {
  const s = states.get(account);
  return s?.turn === agentId && probeKinds(account).includes(kind as BlockerKind);
}

const held = (account: string) => probeKinds(account).flatMap((k) => blockers.blockersFor(account).filter((b) => b.kind === k));

function schedule(account: string, attempt: number, now: number): void {
  const s = states.get(account) ?? { attempt, due: 0 };
  clearTimeout(s.timer);
  s.attempt = attempt;
  s.due = now + backoff(attempt);
  s.timer = setTimeout(() => void runProbe(account).catch((e) => console.error(`cost probe for ${account}:`, e)), Math.max(0, s.due - Date.now()));
  s.timer.unref?.();
  states.set(account, s);
}

// A new failure: starts probing the account, unless a probe is already scheduled. rules.ts
// calls it for a Claude credits signal before evaluating it. A failed probe turn reschedules
// from where it was.
export function start(account: string, now: number = Date.now()): void {
  gens.set(account, generation(account) + 1);
  const s = states.get(account);
  if (!s) return schedule(account, 0, now);
  if (s.turn) failTurn(account, s, now);
}

function stop(account: string): void {
  clearTimeout(states.get(account)?.timer);
  states.delete(account);
  told.delete(account);
}

// A transient or auth provider error ended a turn on a managed agent: block the account's
// agents, mail the human once for an auth error, and start (or advance) the probe.
export async function onError(agentId: string, cls: 'transient' | 'auth', source: string, now: number = Date.now()): Promise<void> {
  const a = db.getAgent(agentId);
  const account = a && accountFor(a);
  if (!account) return;
  const prior = blockers.blockersFor(account).filter((b) => b.kind === 'error');
  // Once told, the outage keeps the mark through later errors of either class.
  // A new outage: no blocker and no probe yet. The probe starts here, before any await, so
  // a second error arriving meanwhile joins this outage.
  if (!prior.length && !states.has(account)) told.delete(account);
  if (prior.some((b) => b.clear?.human === true)) told.add(account);
  if (cls === 'auth' && !told.has(account) && tellHuman(account, source)) told.add(account);
  const human = told.has(account);
  // Starts the probe, or marks the one under way stale: it tested the account before this.
  start(account, now);
  const reason =
    cls === 'auth'
      ? `an authentication error after the harness's retries, ${source}; stam probes the account (1, 2, 4, 8, 16 minutes, then every 16) and clears this when one succeeds, which needs the login fixed`
      : `a provider error after the harness's retries, ${source}; stam probes the account (1, 2, 4, 8, 16 minutes, then every 16) and clears this when one succeeds`;
  const clear = { after: new Date(now).toISOString(), class: cls, ...(human ? { human: true } : {}) };
  for (const x of db.listAgents()) {
    if (!db.isLive(x) || accountFor(x) !== account) continue;
    const have = blockers.blockers(x).find((b) => b.kind === 'error' && b.account === account);
    if (have?.reason === reason && have.clear?.human === clear.human) continue;
    db.addEvent(x.id, 'cost:rule', { rule: 'error', account, action: 'set', reason });
    await blockers.addBlocker(x, { kind: 'error', account, reason, clear });
  }
}

function tellHuman(account: string, source: string): boolean {
  if (!humanMailAllows('necessary')) return false;
  const agents = db.listAgents().filter((x) => db.isLive(x) && accountFor(x) === account).map((x) => x.name);
  const body = render('cost-error-human', { account, source, agents: agents.join(', ') || '(none)' });
  void sendFromStam([HUMAN], `[stam] ${account}: authentication error stops its agents`, body).catch(() => {});
  return true;
}

// A probe is due: run it, and clear the account or schedule the next one.
export async function runProbe(account: string, now: number = Date.now()): Promise<void> {
  const s = states.get(account);
  if (!s) return;
  const acct = settings().cost.accounts?.[account];
  if (!acct?.match || !held(account).length) return stop(account);
  // A probe turn that showed nothing by now is abandoned: its agent is held again, and this
  // step probes anew.
  const abandoned = s.turn ? failTurn(account, s, now, false) : undefined;
  const gen = generation(account);
  let out: ProbeOutcome;
  try {
    out = await prober(account, acct);
  } catch {
    out = 'fail';
  }
  if (states.get(account) !== s) return;
  // The blockers cleared some other way while it ran (a fallback's continue, say).
  const rows = held(account);
  if (!rows.length) return stop(account);
  // A failure that arrived while it ran is newer than what it tested.
  if (out === 'ok' && generation(account) !== gen) out = 'fail';
  db.addEvent(rows[0].agent_id, 'cost:probe', { account, attempt: s.attempt, outcome: out });
  if (out === 'ok') return succeeded(account, `a probe of ${account} succeeded`);
  if (out === 'turn') await startTurn(account, s, abandoned);
  // The next step; for a probe turn, also when it is abandoned.
  if (states.get(account) === s) schedule(account, s.attempt + 1, now);
}

// Lets one blocked agent run a turn as the probe: the one blocked longest that only probe
// blockers hold, the agent of an abandoned probe turn last. With none, the probe waits for
// the next step.
async function startTurn(account: string, s: State, last?: string): Promise<void> {
  const kinds = probeKinds(account);
  const order = (b: blockers.Blocker) => (b.agent_id === last ? 1 : 0);
  for (const b of held(account).sort((x, y) => order(x) - order(y) || x.since.localeCompare(y.since))) {
    const a = db.getAgent(b.agent_id);
    if (!a || a.lifecycle !== 'paused' || lifecycle.pauseOwners(a).length) continue;
    if (blockers.blockers(a).some((x) => !(kinds.includes(x.kind) && x.account === account))) continue;
    try {
      // Checked again in the agent's serial chain: a pause queued ahead of this one (the
      // human's, say) wins, and resumeNow would otherwise erase its owner.
      const started = await lifecycle.serial(a.id, async () => {
        const now = db.getAgent(a.id);
        if (!now || now.lifecycle !== 'paused' || lifecycle.pauseOwners(now).length) return false;
        s.turn = a.id;
        db.addEvent(a.id, 'cost:probe', { account, attempt: s.attempt, turn: true });
        const what = blockers.blockers(a).map((x) => `${x.kind} on ${account}`).join(', ');
        await lifecycle.resumeNow(a.id, render('cost-probe-turn', { blocker: what }));
        return true;
      });
      if (started) return;
    } catch (e) {
      db.addEvent(a.id, 'cost:probe', { account, error: e instanceof Error ? e.message : String(e) });
      s.turn = undefined;
    }
  }
}

// The probe turn failed (an error signal) or showed nothing in time: hold its agent again and,
// unless the caller probes at once, wait for the next step.
function failTurn(account: string, s: State, now: number, reschedule = true): string {
  const id = s.turn!;
  s.turn = undefined;
  // Its blockers never left, so a pause re-holds it; a failed turn's own signal may already have.
  const a = db.getAgent(id);
  if (a?.lifecycle === 'active' && blockers.blockers(a).length) void lifecycle.serial(id, () => lifecycle.pauseNow(id, null)).catch(() => {});
  if (reschedule) schedule(account, s.attempt, now);
  return id;
}

// The probe agent's model answered: a Stop or PostToolUse hook. Clears the account.
export function turnSucceeded(agentId: string): void {
  for (const [account, s] of states)
    if (s.turn === agentId)
      void succeeded(account, `${db.getAgent(agentId)?.name ?? agentId}'s turn, the probe, got a model response`).catch((e) => console.error(`cost probe for ${account}:`, e));
}

async function succeeded(account: string, why: string): Promise<void> {
  const gen = generation(account);
  stop(account);
  for (const b of blockers.blockersFor(account).filter((x) => x.kind === 'error')) {
    if (generation(account) !== gen) return;
    db.addEvent(b.agent_id, 'cost:rule', { rule: 'error', account, action: 'clear', reason: b.reason, cleared: why });
    await blockers.clearBlocker(b.agent_id, 'error', account, why);
  }
  if (probeKinds(account).includes('credits-out')) await rules.probeCleared(account, why, gen);
}

// At daemon start: probe every account that has an error blocker, or a Claude credits-out,
// from the first step. A probe turn that was running when the daemon stopped (its agent is
// active with only probe blockers, and its last probe event started the turn) is taken up
// again, so its result still counts and a timeout still re-holds it.
export function resumeAll(now: number = Date.now()): void {
  for (const account of Object.keys(settings().cost.accounts ?? {})) {
    if (!held(account).length || states.has(account)) continue;
    schedule(account, 0, now);
    const kinds = probeKinds(account);
    for (const b of held(account)) {
      const a = db.getAgent(b.agent_id);
      if (a?.lifecycle !== 'active' || lifecycle.pauseOwners(a).length) continue;
      if (blockers.blockers(a).some((x) => !(kinds.includes(x.kind) && x.account === account))) continue;
      const last = db.listEvents(a.id, 200).filter((e) => e.type === 'cost:probe').at(-1);
      if (!last || JSON.parse(last.data ?? '{}').turn !== true) continue;
      states.get(account)!.turn = a.id;
      break;
    }
  }
}

// Tests start from a clean slate.
export function reset(): void {
  for (const a of [...states.keys()]) stop(a);
  told.clear();
  gens.clear();
}
