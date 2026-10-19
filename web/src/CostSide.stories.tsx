import { CostSide } from './CostSide'
import { OnMount, Side } from './stories/helpers'
import { ds, type Story } from './stories/types'
import { ACCOUNT_CLAUDE, ACCOUNT_CODEX, ACCOUNT_OPENCODE, ACCOUNT_OR_AGENTS, ACCOUNT_OR_SYSTEM, ACCOUNT_STALE } from './usage/story-data'
import type { Account } from './usage/types'

// A Claude subscription with extra credits: its API-equivalent use, paid spend, and a budget.
const WITH_CREDITS: Account = {
  ...ACCOUNT_CLAUDE, account: 'fixture-claude-extra',
  paid: { today: { usd: 2, source: 'exact' }, week: { usd: 9, source: 'exact' }, month: { usd: 18, source: 'exact' } },
  budget: { usd: 40, per: 'month', spent: 18, remaining: 22 },
}
const route = (accounts: Account[]) => ({ 'GET /api/usage': { accounts } })
// Opens the first entry's details the way the pointer (a desktop) or a tap (a phone) does.
const openFirst = (el: HTMLElement) => {
  const row = el.querySelector<HTMLElement>('.csd-row')!
  row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  row.click()
}

export const stories: Story[] = [{
  name: 'Cost',
  group: 'Tree and shell',
  what: 'The Cost tab of the desktop sidebar panes: one compact entry per subscription or paid account stam manages. A subscription shows its 5-hour and 7-day meters, and when the data exists its API-equivalent use, its actual paid spend (extra credits), and a budget bar. An account with no subscription, such as OpenRouter, shows its paid spend and its budget bar. The details open from the entry.',
  when: 'The sidebar panes on a desktop, in the third pane beside Machines (showing by default); clicking the showing tab opens the Usage page. A phone does not draw panes. It loads when the tab mounts, again on a usage change (at most every 30 seconds; a change inside the gap loads when it ends), when the page becomes visible, and every 5 minutes.',
  code: ['web/src/CostSide.tsx#CostSide', 'web/src/cost-side.ts#costEntry'],
  rules: [
    'An entry is two lines: the account, its harness, and the figures it has (`≈$ API` for API-equivalent use, `$ paid`, `≈` for an estimate); then the meters. A figure the account lacks is left out.',
    'Meters are `--status-neutral-bg` tracks, 5-hour and 7-day side by side with their percent. The fill is `--status-neutral-fg`, `--status-warning-fg` when the forecast reaches 100% before the reset, and `--status-error-fg` at 100%; the hatched span is the forecast at reset. Colour is never the only signal: each meter has its label, percent, and accessible name.',
    'A budget bar shows spent over total, warning from 80% and error when spent. An API-only account has no meters, only its budget bar; a subscription with a budget shows the bar as a third line.',
    'A stale reading shows `stale` and forecasts nothing. An account with no windows, paid spend, or budget is not listed.',
    'On a desktop the details are a popover to the entry\'s right, opened by hover or by Enter or Space on the focused entry (reset times, the forecast and when it hits 100%, this period\'s API-equivalent and paid figures, the budget); on a phone a tap opens them as a sheet (' + ds('Menus, overlays, and inputs') + '). An entry is `--size-hit-touch` high on a phone (' + ds('Density') + '). Meters have no animation (' + ds('Motion') + ').',
  ],
  states: [
    { name: 'Subscriptions and an API account', routes: route([ACCOUNT_CLAUDE, ACCOUNT_CODEX, ACCOUNT_OR_AGENTS]), render: () => <Side><CostSide /></Side> },
    { name: 'Credits and a budget', routes: route([WITH_CREDITS, ACCOUNT_OPENCODE]), render: () => <Side><CostSide /></Side> },
    { name: 'Stale reading', routes: route([ACCOUNT_STALE, ACCOUNT_OR_SYSTEM]), render: () => <Side><CostSide /></Side> },
    { name: 'Details open', height: 380, overlay: '.csd-pop', routes: route([WITH_CREDITS, ACCOUNT_CODEX]), render: () => <OnMount run={openFirst}><Side><CostSide /></Side></OnMount> },
    { name: 'Nothing to show', routes: route([]), render: () => <Side><CostSide /></Side> },
  ],
}]
