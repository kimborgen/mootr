import { ds, type Story } from '../stories/types'
import { AccountCard, BlockedCallout, BudgetSplit, LimitsBand } from './Limits'
import { ACCOUNT_OR_AGENTS, ACCOUNT_OR_SYSTEM_UNSET, ACCOUNT_BUSY_DAY, ACCOUNT_CLAUDE, ACCOUNT_CODEX, ACCOUNT_OPENCODE, ACCOUNT_STALE, ALLOCATIONS, BLOCKED, USAGE_CALM } from './story-data'
import type { Account } from './types'

// An account stam has seen but has never had a reading for: no window, no credit, no budget.
const SILENT: Account = {
  ...ACCOUNT_CODEX, account: 'fixture-codex-idle', windows: {}, balance: null, budget: null, shares: null,
  paid: { today: { usd: null, source: 'unknown' }, week: { usd: null, source: 'unknown' }, month: { usd: null, source: 'unknown' } },
}
// A paid account with no window and no credit: only the month's spend is known.
const PAID: Account = { ...ACCOUNT_OPENCODE, account: 'fixture-paid-only', windows: {}, balance: null, budget: null, shares: null }
// A pay-per-token provider other than OpenRouter (S-2119): no balance, its spend priced from tokens, with a budget.
const PROVIDER: Account = {
  ...ACCOUNT_OPENCODE, account: 'fixture-azure', match: { harness: 'opencode', model: 'fixture-azure/' }, provider: 'fixture-azure', balance: null, shares: null,
  paid: { today: { usd: 0.62, source: 'estimate' }, week: { usd: 3.4, source: 'estimate' }, month: { usd: 8.1, source: 'estimate' } },
  budget: { usd: 10, per: 'month', spent: 8.1, remaining: 1.9 },
}
const MORE: Account[] = [
  { ...ACCOUNT_CLAUDE, account: 'fixture-claude-two' },
  { ...ACCOUNT_OPENCODE, account: 'fixture-openrouter-two', budget: null },
  { ...ACCOUNT_CODEX, account: 'fixture-codex-two', stale: true, age_ms: 4 * 3_600_000, shares: null },
]

const band = (accounts: Account[], allocations = ALLOCATIONS, compact = false) => () => (
  <div className="pad usage"><LimitsBand accounts={accounts} allocations={allocations} compact={compact} /></div>
)
const blocked = () => (
  <div className="pad usage"><BlockedCallout rows={BLOCKED} /><LimitsBand accounts={[ACCOUNT_CODEX]} allocations={[]} compact={false} /></div>
)
const cards = (...list: Account[]) => () => (
  <div className="pad usage">
    {list.map((a) => <AccountCard key={a.account} a={a} allocations={ALLOCATIONS.filter((x) => x.account === a.account)} />)}
  </div>
)

export const stories: Story[] = [{
  name: 'Usage limits band',
  group: 'Settings',
  what: 'The top of the Usage Overview: the blocked callout, one line per blocked agent with an Open link, and the limits band, one card per configured account. A card names the account and its harness, marks a reading older than the last sample as stale with its age, and then draws each reading: one block per window (\'5-hour\', \'Week\') with its percent, the forecast to where it stands at reset as a hatched stripe, its reset time and its rate per hour; a credit balance with the month\'s paid spend; the paid spend alone when there is no window or credit; a budget with its spend and a meter; and the tree allocations that account funds. On a drilled scope the band is one compact line of chips instead of cards.',
  when: 'The Overview tab of the Usage page (`usage` world), above the headline tiles (web/src/usage/Overview.tsx): the callout only when agents are blocked, the band whenever the page has accounts.',
  code: ['web/src/usage/Limits.tsx#LimitsBand', 'web/src/usage/Limits.tsx#AccountCard', 'web/src/usage/Limits.tsx#BlockedCallout', 'web/src/usage/Limits.tsx#BudgetSplit'],
  rules: [
    'A window\'s `.lim-meter` is `--space-2` tall with `--radius-xs` corners on a `--status-neutral-bg` track; it fills with `--accent`, turns `--status-warning-fg` when the forecast reaches 100% before the reset and `--status-error-fg` at 100%, and the forecast is a hatched `--lim-ink` stripe from the used percent to the projected one',
    'Under a window\'s meter are two lines, \'7-day pace\' and \'24h pace\', each the window\'s average rate over that span and where it ends at reset at that rate (or \'100% ≈ HH:MM\' in `--status-warning-fg` when it reaches 100% first); each also draws a thin tick on the meter at its percent at reset, both full-height `--text-primary` ticks ringed by a `--surface-raised` gap so they show inside the hatch, the 7-day one twice as wide as the 24h one, each kept whole at the right edge of the meter when its pace reaches 100%; a pace with too little history is left out, and the hatch and the \'/h now\' figure stay the last 30 minutes\' rate. The compact line names the pace that reaches 100%',
    'The cards are a grid of at least `--space-12` × 4 each, `--radius-sm` corners, a `--border-subtle` hairline and a `--surface-raised` fill; a percent is `--type-chrome-xl` at `--weight-semibold` in tabular figures (' + ds('Surfaces and elevation') + ')',
    'A pay-per-token provider other than OpenRouter (`provider` set) names it after the harness ("Opencode · ID, per token"), has no credit line, and says its spend is priced from its tokens at the registry\'s prices; its spend is an estimate',
    'A paid amount reads exact, or "≈" for an estimate; an unknown amount is none, never "$0.00", and a subscription account with windows has no paid spend at all (' + ds('Status') + ')',
    'A stale reading takes a `warn` badge with its age and forecasts nothing; an allocation at 80% used or more takes warning ink; a budget meter uses the same 80% and 100% thresholds as a window',
    'With no accounts the band says "No accounts configured."; an account with no reading of any kind says "No reading for this account yet." (' + ds('Empty, loading, and error') + ')',
    'A blocked line is one `--mb-*` line per agent with "Blocked" in `--status-warning-fg` and a text-button Open, inside the page\'s warning callout',
    'Compact, on a drilled scope, is one `--type-chrome-sm` line under an eyebrow: per account its name and then each window\'s percent, or its credit when it has no window',
    'The System card names the system reserve and the credit left in one `--type-chrome-sm` line; once the credit is within the reserve that line takes warning ink (`low`), and an unknown credit reads "unknown"',
  ],
  states: [
    { name: 'Each harness, windows near 100%', render: band([ACCOUNT_CLAUDE, ACCOUNT_CODEX, ACCOUNT_OPENCODE]) },
    { name: 'A quiet week and a busy day', render: cards(ACCOUNT_BUSY_DAY) },
    { name: 'Agents blocked on a window', render: blocked },
    { name: 'A calm week', render: band(USAGE_CALM.accounts ?? [], []) },
    { name: 'A stale reading', render: band([ACCOUNT_STALE], []) },
    { name: 'A credit and a budget', render: cards(ACCOUNT_OPENCODE) },
    { name: 'Paid, with no window or credit', render: cards(PAID) },
    { name: 'No reading for the account', render: cards(SILENT) },
    { name: 'A provider billed per token, with a budget', render: cards(PROVIDER) },
    { name: 'Six accounts', render: band([ACCOUNT_CLAUDE, ACCOUNT_CODEX, ACCOUNT_OPENCODE, ...MORE]) },
    { name: 'Agents and System budgets', render: () => <div className="pad usage"><BudgetSplit accounts={[ACCOUNT_OR_AGENTS, ACCOUNT_OR_SYSTEM_UNSET]} reserve={{ reserve: 1, remaining: 12.5 }} /></div> },
    { name: 'Credit within the system reserve', render: () => <div className="pad usage"><BudgetSplit accounts={[ACCOUNT_OR_AGENTS, ACCOUNT_OR_SYSTEM_UNSET]} reserve={{ reserve: 1, remaining: 0.8 }} /></div> },
    { name: 'Credit reading stale', render: () => <div className="pad usage"><BudgetSplit accounts={[ACCOUNT_OR_AGENTS, ACCOUNT_OR_SYSTEM_UNSET]} reserve={{ reserve: 1, remaining: null }} /></div> },
    { name: 'No accounts configured', render: band([]) },
    { name: 'Compact, on a drilled scope', render: band([ACCOUNT_CLAUDE, ACCOUNT_OPENCODE], [], true) },
  ],
}]
