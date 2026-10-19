# Cost policy: managers control cost, stam tracks and enforces the user's rules

Design, 2026-10-11, third revision. The brief: "The key here is that managers can manage the cost. CoS especially." Stam tracks usage, attributes it, estimates, notifies, and offers tools. Managers, the chief of staff above all, make the calls, guided by the user's free-text cost instructions. Stam enforces only what the user states as a rule.

## Terms

- **Account**: one provider login or key that agents bill to (Claude Max, Codex Plus, OpenRouter). Each agent matches at most one, by harness and model prefix (`src/accounts.ts`). An agent that matches none is **unmanaged**: tracked and shown, never gated.
- **Window**: a subscription limit the provider reports as a percentage: Claude `five_hour`, `seven_day` and model windows; Codex primary and secondary.
- **Paid spend**: real dollars: exact (OpenRouter `usage` and `limit_remaining`, Codex `credits.balance`), estimate (Claude extra usage, shown as "≈"), or unknown (no reading in 15 minutes).
- **API-equivalent cost**: what tokens would cost at API prices. Stats and attribution weights only.
- **Tree**: an agent and its descendants. Its **manager** is the root's parents; a root without one is managed by the chief of staff.

## The user's part

**Cost instructions**: free text in Settings (`cost.instructions`). Stam puts it into the chief of staff's template, into every manager's spawn prompt, into every cost notice, and into `usage_info`. Managers follow it with stam's numbers.

**Rules**: only what the user states as a rule becomes config that stam enforces:

- `paid: false` on an account: never spend extra credits there. When a window reads 100%, the account's agents stop until it resets.
- `budget` on an account or globally: paid dollars per `day`, `week` or `month`, or a `cap` that holds until raised.
- Only the user raises a cap or turns `paid` on. Managers can't.

Facts that stop work whatever the config says (credits at zero, a provider refusing) are blockers too.

## Example setup

The example user's rules: never extra credits on Claude or Codex; OpenRouter is a $10 experiment, likely raised later, needn't last a month, cost matters little there.

```json
"cost": {
  "instructions": "Never spend extra credits on Claude or Codex. OpenCode on OpenRouter is an experiment with $10 of credit that I'll probably raise; it doesn't have to last a month, so cost matters little there.",
  "accounts": {
    "claude-max": { "match": { "harness": "claude" }, "paid": false,
      "onSubExhausted": { "action": "take-over", "to": ["codex"], "else": "wait" } },
    "codex-plus": { "match": { "harness": "codex" }, "paid": false, "onSubExhausted": "wait" },
    "openrouter": { "match": { "harness": "opencode", "model": "openrouter/" }, "subscription": false,
      "lowCreditsUsd": 2 }
  },
  "fallbackMinutes": 15
}
```

The only rules here are the two `paid: false`. OpenRouter has no stam budget: the key's own $10 is the limit, and `credits-out` stops work when it's gone. The `on*` actions are fallbacks (below), not policy. The user might then tell the chief of staff "give the stam2 tree about 30% of the 5-hour window": an allocation, not a rule.

## Readings

Stam reads limits continually, since providers change them often: Claude on every statusline refresh; Codex on `account/rateLimits/updated` plus `account/rateLimits/read` every 5 minutes while its agents run; OpenRouter credits every 5 minutes. A reading older than 15 minutes is unknown, and an unknown reading never clears a blocker. Limit errors per harness come from `classifyError` (built).

## Attribution and estimates

Stam records each agent's tokens (input, output, cache read, cache write) and model per reading interval, not just per day, so every change in a window's percentage can be split among the agents that ran.

- **Weights**: tokens are weighted by model and token type, starting from the registry's API prices.
- **Calibration**: each fresh reading fits the weights to the observed percent change, per account and window. A miss of more than 25% resets the fit (the formula changed).
- **Share**: an agent's estimated percent of a window is its weighted tokens over all weighted tokens on that account in the interval, times the reading's change. A tree's share is the sum over its agents. Change no stam agent explains shows as **other** (the user's own use outside stam).
- **History**: percent per hour by account, tree and agent, kept by hour of day and day of week. It gives projections ("five_hour reaches 100% around 15:40 at today's rate") and estimates for planned work ("a tree like this used about 12% of a 5-hour window").

All estimates are labelled as estimates. They time notices and inform managers; they never set or clear a blocker.

## Allocations

The user or a manager sets an allocation on a tree: "tree T may use about X% of ACCOUNT's `five_hour` window" or "about $Y per day of paid spend". A manager may allocate only within its own tree's allocation; stam warns, never refuses, when children's allocations add up past it.

Allocations aren't enforced. At 80% and 100% of an allocation, stam notifies the tree's manager and the tree's root, with the numbers, the projection, and the user's instructions. What happens next is the manager's call.

## Notices to managers

Each cost event goes to the responsible manager through `queueNotice` (in-turn notices pass the gate, mail to an idle manager starts a turn):

| Event | Goes to |
|---|---|
| window at `warnPercent`, or projected 100% within 30 minutes | managers of trees on that account, by share |
| allocation at 80% or 100% | the tree's manager and root |
| rule blocker set or cleared | the agent's manager |
| low credits, budget at 90% | managers of trees on that account |
| unrecoverable provider error | the agent's manager, and the human (one thread per account) |

Every notice carries the user's instructions, the tree's usage and estimate, the options it has (the tools below), and the fallback that runs if nobody acts. The agent itself gets `cost-warning.md` or `cost-prepare.md` (keep `HANDOVER.md` current).

**Fallback**: when a notice about a blocked or exhausted agent goes `fallbackMinutes` without its manager acting on that agent (any tool below, or `cost_ack`), stam applies the account's `onSubExhausted`, `onBudgetExhausted`, `onCreditsOut` or `onError` action, and tells the chief of staff. If the chief of staff is itself unavailable or blocked, stam mails the human. Without a configured action the fallback is `wait`.

## Manager tools

MCP tools and `stam` commands, usable by a manager on its own tree (the chief of staff on any):

- `usage_info tree=AGENT`: per agent and tree, each window's share, paid spend, allocations, projection, history, blockers, and the user's instructions.
- `cost_allocate TREE`: set or clear an allocation.
- `cost_pause TREE until=reset`: pause agents until a fresh reading shows the window reset, or until a time. A cost pause is its own lifecycle owner, lifted by stam on that reading.
- `cost_switch AGENT PRESET`: move the work to another preset with a handover (below).
- `cost_ack EVENT`: "handled, leave it", which stops the fallback timer.

Every tool goes through the rules: a switch onto an account with a blocker, or onto paid spend a rule forbids, is refused with the reason.

**Switch with handover**: soft-stop the agent (finish the turn, update `HANDOVER.md`), interrupt after a deadline; create a successor `NAME-t2` (unique even among archived) on the preset, same role, cwd, worktree, branch, machine, personal workspace and `standing` flag; in one transaction move its parents, children, open threads and mail forwarding; launch it with `takeover.md` (spawn prompt, `HANDOVER.md`, predecessor transcript path, last compaction summary). Allocations belong to trees by their own ids, so they survive. Managers decide whether work moves back later.

## Rule enforcement

Each agent carries a persisted set of blockers, each with its own clear condition:

| Blocker | Set when | Clears only when |
|---|---|---|
| `window:ACCOUNT:W` | `paid: false` and W reads 100%, or a limit error | a fresh reading of W below 100% |
| `paid-forbidden:ACCOUNT` | paid spend appears on a `paid: false` account | the window resets |
| `budget:SCOPE` | paid spend ≥ that scope's budget | the period rolls over, or the user raises it |
| `credits-out:ACCOUNT` | verified balance ≤ 0, a 402, or `spendControlReached` | a fresh balance ≥ `lowCreditsUsd`; Claude, with no balance: a probe succeeds |
| `error:ACCOUNT` | provider error after the harness's retries | a probe succeeds (1, 2, 4, 8, 16 min) |

Stam runs an agent only when its blocker set is empty and no human, parent or cost pause holds it. **Admission gate**: `admit(agent, kind)` before every model turn: mail prompts, `pushPrompt`, ring turns, compaction, resume, restart, unpause, spawn. A blocked agent's mail waits unread until its blockers clear; paused agents get mail as before. When a limit error ends a turn the agent is already stopped; when a rule trips mid-turn, stam soft-stops it (hard-stop after 10 minutes via adapter `interrupt()`).

### Budgets across machines

A budget counts every machine's paid spend (S-395). Each daemon serves its own totals at `GET /api/usage/spend` and keeps its peers' last answers (`src/peer-spend.ts`, refreshed every 30 seconds); a budget evaluation adds them to the local ledger. Every machine blocks its own agents, but only the settings home mails the human and sends the 90% notice. A peer that stops answering counts at its last total for 10 minutes, then as zero, so it never holds a spawn. `usage_info` carries `paid_spend_by_machine`. Subscription readings and warnings are still per machine.

### System vs agent budget (S-1077)

Stam's own model calls bill to the account `openrouter-system`, apart from the agents' `openrouter`. Both are OpenRouter-billed (the same credit and key), so the global budget counts both. `cost.accounts.openrouter.budget` is the agents' budget; the system budget is `cost.accounts['openrouter-system'].budget`, on an account with a match no agent has, for example `{ "match": { "harness": "stam" }, "budget": { "usd": 3, "per": "day" } }`. A spent agents budget never stops a system call. A spent system budget (`budgets.systemHeld`) makes `decide`, the mail titles and the block summaries skip their call, and `decide` records a `decide:error` event, as it does for any failure. The 90% notice for the system scope goes to the chief of staff, and the human gets the usual raise Decision. Only the human edits either budget. The first start after this change moves old `stam` rows from `openrouter` to `openrouter-system` once.

The two accounts share one OpenRouter credit, so the agents can't be left to spend the system's share of it (the reserve). While the last credit reading (`credits.ts`, fetched whole within 15 minutes; an older one decides nothing and asks for a fresh poll) is at or below the reserve, the `openrouter` scope carries a `budget` blocker (clear `{ reserve }`, a reason with no amount, so a moving reserve doesn't rewrite it) and `spawnHeld` refuses new OpenRouter agents; a top-up clears it. `credits.ts` polls while agents are held for it, and a refused spawn asks for a fresh balance, so a top-up with no OpenRouter agent running still lifts the hold. The reserve is the unspent part of the system budget, or `cost.openrouterSystemReserveUsd` (default 1) when that account has none. System calls are never stopped by it. A `reserve-near` notice goes to the managers on OpenRouter and the chief of staff once per top-up, when the credit is within twice the reserve. An agents budget that is spent takes precedence over the reserve blocker.

### Ledger writers

Every code path that writes paid spend to the `usage` table must tell the budgets, or a spent budget goes unseen until the next unrelated evaluation (retro S-309). There are three:

- `usage.report` (`src/usage.ts`): an agent's cost and tokens. Calls `budgets.onSpend(account)` itself.
- `recordCost` in `src/decide.ts`: stam's own model calls (mail gate, summaries, titles, decisions) on the `openrouter-system` account. Must call `budgets.ledgerChanged()`.
- `reconcile()` in `src/reconcile.ts`: scales the OpenCode rows down to the billed amount. Must call `budgets.ledgerChanged('reconciled')`.

A new writer calls `budgets.ledgerChanged()` after its write and is added to this list.

## What the human gets

Mail from `stam` itself, only for: a cap or budget reached (a Decision to raise it, or keep stopped), an unrecoverable provider error, a fallback the chief of staff couldn't take, and a rejected config. Everything else goes to managers. The Usage page shows readings, shares per tree, allocations, history, blockers and unmanaged agents; Settings edits the instructions and accounts.

## Build steps (one agent each)

1. **Limit signals**: `classifyError` per adapter with fixtures. *Built.*
2. **Accounts config**: matching, validation, unmanaged agents, `account` column. *Built*; step 8 adds `instructions` and `fallbackMinutes`.
3. **Readings**: Claude windows, Codex rate limits, OpenRouter poll, staleness, billing sources. *In progress* (`stam/cost-readings`; Codex usage also on unmerged `stam/cost-codex`).
4. **Blockers**: persisted blocker set, separate from pauses, the resume rule. *In progress* (`stam/cost-blockers`).
5. **Admission gate**: `admit()` at every turn start, a test per path. *Built* (`stam/cost-gate`).
5b. **Rule triggers**: `window`, `paid-forbidden` and `credits-out` set and cleared from readings and signals (`src/rules.ts`). *Built*.
6. **Usage samples**: per agent tokens and model per reading interval, beside the daily table.
7. **Attribution**: weights from prices, calibration against readings, agent, tree and other shares, projection. *Built* (`src/attribution.ts`, formulas in its header; prices in the registry's `prices`).
8. **User instructions**: Settings field, into the chief of staff's template, manager spawn prompts, notices and `usage_info`.
9. **History**: per hour-of-day and weekday patterns, estimates for planned work. *Built* (`src/usage-history.ts`); the planned-work estimate covers only the 7-day window, by harness and model.
10. **Allocations**: storage by tree id, `cost_allocate`, `stam allocate`, 80% and 100% checks. *Built* (`src/allocations.ts`).
11. **Manager notices**: routing to the responsible manager, the templates, `cost_ack`.
12. **Pause until reset**: the cost pause owner, lifted on a fresh reading. *Built* (`stam/cost-pause`).
13. **Switch with handover**: adapter `interrupt()`, soft-stop deadline, transactional transfer, `takeover.md`. *Built* (`src/cost-switch.ts`).
14. **Fallback**: timer per notice, the account's `on*` action, escalation to the chief of staff and the human. *Built* (`src/cost-fallback.ts`). `soft-stop` and `hard-stop` work as `wait` with a note, since the gate already holds a blocked agent; `continue` is valid only on a `paid: true` account.
15. **Errors and budgets**: probes with backoff, budget scopes, the human's raise Decision, `stam` as mail sender. *Budgets built* (`src/budgets.ts`); probes *built* (`src/cost-probes.ts`: `error:ACCOUNT` from `transient` and `auth` signals, and Claude's `credits-out`, cleared by a probe; Claude probes with one agent's next turn, the module header says why).
16. **UI**: Usage per tree and Settings, checked on phone and desktop.
17. **End-to-end**: a test daemon with fake accounts, synthetic readings and errors, a manager agent acting on notices, and the fallback when it doesn't, on all three harnesses. *Built* (`test/e2e-cost.sh`); the `error:ACCOUNT` scenario is skipped until the error probes (step 15) are merged.

## What an agent's token may read (S-593)

The human, the CLI and the bosses (chief of staff, assistant, a boss-flagged peer) read every cost number. Any other agent's token gets the windows' totals, forecasts and notices in full, but per-agent and per-tree shares only for its own tree and its ancestors' trees (`src/usage-scope.ts`); every other tree collapses into one `other` line. `usage?tree=X` and `agents/X/usage` are 403 outside those trees. `usage/issues` and `activity?by=itsa` list only ITSAs the agent owns, takes part in, or whose parent it owns (the rest are left out); `activity?by=agent` lists only its visible agents. `GET /api/permissions` lists the caller's own and its tree's requests. Cost notices and pacing read the data directly, so they keep full totals. The OpenCode server names its agent with `as`.
