// The top of the Overview: the blocked callout and the limits band, one card per account with each
// window's meter, a hatched forecast from used to the projected percent at reset, and a warning
// when the forecast reaches 100% first. On a drilled scope the band is one compact line.
import { openAgent } from '../actions'
import { HARNESS } from '../format'
import type { Account, Allocation, Budget, BlockedAgent, Pace, PaidPeriod, Reserve, Window, WindowShares } from './types'
import { m, openSpending, timeOf, winLabel } from './shared'

const LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'Week' }
const label = (w: string) => LABEL[w] ?? winLabel(w)

export interface Forecast {
  used: number
  // Where the window stands at its reset at the current rate, capped at 100; null when no rate is known.
  atReset: number | null
  // When it reaches 100% before the reset, as an instant; null when it resets first or is unknown.
  hitAt: string | null
  rate: number | null
}

// A window's forecast, from the API's projection. A stale reading forecasts nothing.
export function forecast(win: Window, s: WindowShares | undefined, stale: boolean, now = Date.now()): Forecast {
  const used = win.used_percentage ?? 0
  const p = s?.projection
  if (stale || !p) return { used, atReset: null, hitAt: null, rate: null }
  const rate = p.percent_per_hour
  if (p.reaches_100_at) return { used, atReset: 100, hitAt: p.reaches_100_at, rate }
  const resets = p.resets_at ? Date.parse(p.resets_at) : win.resets_at ? win.resets_at * 1000 : NaN
  if (rate == null || Number.isNaN(resets)) return { used, atReset: null, hitAt: null, rate }
  return { used, atReset: Math.min(100, Math.max(used, used + (rate * Math.max(0, resets - now)) / 3_600_000)), hitAt: null, rate }
}

export interface PaceLine {
  key: 'pace_7d' | 'pace_24h'
  label: string
  rate: number
  atReset: number | null
  hitAt: string | null
}

const PACES: [PaceLine['key'], string][] = [['pace_7d', '7-day pace'], ['pace_24h', '24h pace']]

// The two flat-rate forecasts of a window, in order 7-day then 24h; one is left out when its
// history was too thin, and a stale reading has none.
export function paceLines(s: WindowShares | undefined, stale: boolean): PaceLine[] {
  const p = s?.projection
  if (stale || !p) return []
  const out: PaceLine[] = []
  for (const [key, label] of PACES) {
    const v: Pace | null | undefined = p[key]
    if (v) out.push({ key, label, rate: v.percent_per_hour, atReset: v.at_reset, hitAt: v.reaches_100_at })
  }
  return out
}

const paceText = (l: PaceLine) => (l.hitAt ? `100% ≈ ${timeOf(l.hitAt)}` : l.atReset != null ? `≈${Math.round(l.atReset)}% at reset` : `≈${l.rate.toFixed(l.rate >= 10 ? 0 : 1)}%/h`)

export const tone = (f: Forecast): '' | 'warn' | 'over' => (f.used >= 100 ? 'over' : f.hitAt ? 'warn' : '')
const hhmm = (iso: string) => timeOf(iso)

function WindowMeter({ used, atReset, tone: t, name, paces = [] }: { used: number; atReset: number | null; tone: string; name: string; paces?: PaceLine[] }) {
  const u = Math.min(100, used)
  const hatch = atReset != null && atReset > u ? atReset - u : 0
  return (
    <div className={'lim-meter ' + t} role="img" aria-label={`${name}: ${used}% used${atReset != null ? `, about ${Math.round(atReset)}% at reset` : ''}`}>
      <i className="fill" style={{ width: u + '%' }} />
      {hatch > 0 ? <i className="proj" style={{ left: u + '%', width: hatch + '%' }} /> : null}
      {paces.filter((l) => l.atReset != null).map((l) => <i key={l.key} className={'pace ' + l.key} style={{ left: `min(${Math.max(u, l.atReset ?? 0)}%, calc(100% - var(--space-1)))` }} />)}
    </div>
  )
}

function WindowRow({ w, win, shares, stale }: { w: string; win: Window; shares?: WindowShares; stale: boolean }) {
  const f = forecast(win, shares, stale)
  const paces = paceLines(shares, stale)
  const t = tone(f) || (paces.some((l) => l.hitAt) ? 'warn' : '')
  const warn = t !== ''
  const note = f.used >= 100 ? 'at 100%' : f.hitAt ? `100% ≈ ${hhmm(f.hitAt)}` : f.atReset != null ? `≈${Math.round(f.atReset)}% at reset` : ''
  return (
    <div className={'lim-win ' + t}>
      <div className="lim-row">
        <span className="lim-name">{label(w)}</span>
        <span className="lim-pct">{f.used}%</span>
        <span className={'lim-note' + (warn ? ' lim-warn' : '')}>{note}</span>
      </div>
      <WindowMeter used={f.used} atReset={f.atReset} tone={t} name={label(w)} paces={paces} />
      <div className="lim-row lim-sub">
        <span>{win.resets_at ? `resets ${timeOf(win.resets_at)}` : 'no reset time'}</span>
        {f.rate != null ? <span>≈{f.rate.toFixed(f.rate >= 10 ? 0 : 1)}%/h now</span> : null}
      </div>
      {paces.map((l) => (
        <div key={l.key} className={'lim-sub lim-row lim-pace' + (l.hitAt ? ' lim-warn' : '')}>
          <span><i className={'pace-key ' + l.key} />{l.label} ≈{l.rate.toFixed(l.rate >= 10 ? 0 : 1)}%/h</span>
          <span>{paceText(l)}</span>
        </div>
      ))}
    </div>
  )
}

function minutes(a: Account): string {
  if (a.age_ms == null) return ''
  const min = Math.max(0, Math.round(a.age_ms / 60_000))
  return min < 180 ? `${min} min` : `${Math.round(min / 60)} h`
}

function AllocRow({ a }: { a: Allocation }) {
  const cap = a.kind === 'window' ? `${a.percent ?? 0}% of ${label(a.window)}` : `${m(a.amount ?? 0)}/${a.period}`
  const used = a.kind === 'window' ? `${a.used}% used` : `${m(a.used)} used`
  const pct = a.used_percent ?? 0
  return <div className={'lim-sub lim-alloc' + (pct >= 80 ? ' lim-warn' : '')}>{a.root}: {cap} · {used}</div>
}

// A paid amount stam knows: exact or an estimate. An unknown amount is none, never $0.00, and a 0
// estimate on an account with windows is none too: a subscription is flat, so it has no paid spend.
export function paidKnown(p: PaidPeriod, hasWindows: boolean): number | null {
  if (p.usd == null || (p.source !== 'exact' && p.source !== 'estimate')) return null
  if (hasWindows && p.usd === 0) return null
  return p.usd
}
const paidText = (p: PaidPeriod, usd: number) => (p.source === 'estimate' ? `≈${m(usd)}` : m(usd))

// The two OpenRouter budgets, one credit and key: the agents' account and stam's own model calls.
export const AGENTS_ACCOUNT = 'openrouter'
export const SYSTEM_ACCOUNT = 'openrouter-system'

export type BudgetState = 'ok' | 'low' | 'spent'
// A budget's used share and state: low from 80% (the meters' warn line), spent at 100%.
export function budgetState(b: Budget | null, spent: number | null | undefined = b?.spent): { pct: number | null; state: BudgetState } {
  if (!b || spent == null || !(b.usd > 0)) return { pct: null, state: 'ok' }
  const pct = Math.min(100, (spent / b.usd) * 100)
  return { pct, state: pct >= 100 ? 'spent' : pct >= 80 ? 'low' : 'ok' }
}

function SplitCard({ title, account, unset, reserve }: { title: string; account: Account | undefined; unset: string; reserve?: Reserve | null }) {
  const budget = account?.budget ?? null
  // As the account card did: the budget's own spent figure, else this month's known paid spend.
  const spent = budget?.spent ?? (account ? paidKnown(account.paid.month, Object.keys(account.windows).length > 0) : null)
  const left = budget?.remaining ?? (budget && spent != null ? budget.usd - spent : null)
  const { pct, state } = budgetState(budget, spent)
  return (
    <div className={'lim-card lim-split-card' + (state === 'ok' ? '' : ' ' + state)}>
      <div className="lim-head">
        <b>{title}</b>
        <span className="spacer" />
        {state === 'spent' ? <span className="badge err">spent</span> : state === 'low' ? <span className="badge warn">low</span> : null}
      </div>
      {budget ? (
        <div className="lim-win">
          <div className="lim-row"><span className="lim-name">Spent</span><span className="lim-pct">{spent != null ? m(spent) : '—'}</span><span className="lim-note">of {m(budget.usd)}/{budget.per}</span></div>
          {pct != null ? <div className={'lim-meter' + (state === 'spent' ? ' over' : state === 'low' ? ' warn' : '')} role="img" aria-label={`${title} budget: ${Math.round(pct)}% used`}><i className="fill" style={{ width: pct + '%' }} /></div> : null}
          <div className="lim-sub">{left != null ? `${m(Math.max(0, left))} left` : 'left unknown'}</div>
        </div>
      ) : <div className="lim-sub lim-unset">{unset} <button type="button" className="btn text" onClick={openSpending}>Set in Settings</button></div>}
      {reserve ? <ReserveLine reserve={reserve} /> : null}
    </div>
  )
}

// The system reserve against the credit left: `low` (warning ink) once the credit is within it.
// Cents below $100, since the reserve and the credit are often a few dollars and whole dollars hide the gap.
const withCents = (v: number) => (v < 100 ? '$' + v.toFixed(2) : m(v))
function ReserveLine({ reserve }: { reserve: Reserve }) {
  const low = reserve.remaining != null && reserve.remaining <= reserve.reserve
  return (
    <div className={'lim-sub lim-reserve' + (low ? ' low lim-warn' : '')}>
      Reserve {withCents(reserve.reserve)} · credit left {reserve.remaining != null ? withCents(Math.max(0, reserve.remaining)) : 'unknown'}
    </div>
  )
}

// Agents and System side by side. Shown once either OpenRouter account is configured; with no system
// budget it prompts for one, since stam's own calls (mail gate, summaries, decisions) then share the credit.
export function BudgetSplit({ accounts, reserve }: { accounts: Account[]; reserve?: Reserve | null }) {
  const agents = accounts.find((a) => a.account === AGENTS_ACCOUNT)
  const system = accounts.find((a) => a.account === SYSTEM_ACCOUNT)
  if (!agents && !system) return null
  return (
    <div className="lim-split" aria-label="OpenRouter budgets">
      <div className="eyebrow">OpenRouter budgets</div>
      <div className="lim-cards">
        <SplitCard title="Agents" account={agents} unset="No agents budget." />
        <SplitCard title="System" account={system} reserve={reserve} unset="No system budget: mootr's own model calls (mail gate, summaries, decisions) are not capped." />
      </div>
    </div>
  )
}

export function AccountCard({ a, allocations, split = false }: { a: Account; allocations: Allocation[]; split?: boolean }) {
  const windows = Object.entries(a.windows)
  const mine = allocations.filter((x) => x.account === a.account)
  const paidMonth = paidKnown(a.paid.month, windows.length > 0)
  const hasBudget = a.budget != null
  const none = !windows.length && a.balance == null && !hasBudget && paidMonth == null
  const spent = a.budget?.spent ?? paidMonth
  const bpct = a.budget && spent != null && a.budget.usd > 0 ? Math.min(100, (spent / a.budget.usd) * 100) : null
  return (
    <div className="lim-card">
      <div className="lim-head">
        <b>{a.account}</b>
        <span className="muted">{HARNESS[a.match.harness] ?? a.match.harness}{!windows.length && (a.balance != null || hasBudget) ? ' · paid' : ''}</span>
        <span className="spacer" />
        {a.stale ? <span className="badge warn" title="The last reading is old; treat it as unknown">stale, {minutes(a)} old</span> : a.age_ms != null ? <span className="muted lim-age">read {minutes(a)} ago</span> : null}
      </div>
      {windows.map(([w, win]) => <WindowRow key={w} w={w} win={win} shares={a.shares?.[w]} stale={a.stale} />)}
      {a.balance != null ? (
        <div className="lim-win">
          <div className="lim-row"><span className="lim-name">Credit</span><span className="lim-pct">{m(a.balance)}</span><span className="lim-note">left</span></div>
          {paidMonth != null ? <div className="lim-row lim-sub"><span>{paidText(a.paid.month, paidMonth)} spent this month</span></div> : null}
        </div>
      ) : null}
      {a.balance == null && paidMonth != null ? (
        <div className="lim-win">
          <div className="lim-row"><span className="lim-name">Paid</span><span className="lim-pct">{paidText(a.paid.month, paidMonth)}</span><span className="lim-note">this month</span></div>
          {!windows.length ? <div className="lim-sub">No limit or credit reading for this account.</div> : null}
        </div>
      ) : null}
      {a.budget && !split ? (
        <div className="lim-win">
          <div className="lim-row"><span className="lim-name">Budget</span><span className="lim-pct">{spent != null ? m(spent) : '—'}</span><span className="lim-note">of {m(a.budget.usd)}/{a.budget.per}</span></div>
          {bpct != null ? <div className={'lim-meter' + (bpct >= 100 ? ' over' : bpct >= 80 ? ' warn' : '')} role="img" aria-label={`Budget: ${Math.round(bpct)}% used`}><i className="fill" style={{ width: bpct + '%' }} /></div> : null}
        </div>
      ) : null}
      {mine.map((x) => <AllocRow key={x.id} a={x} />)}
      {none ? <div className="lim-sub muted">No reading for this account yet.</div> : null}
    </div>
  )
}

export function LimitsBand({ accounts, allocations, compact, reserve }: { accounts: Account[]; allocations: Allocation[]; compact: boolean; reserve?: Reserve | null }) {
  if (!accounts.length) return <div className="lim-empty muted">No accounts configured.</div>
  if (compact) {
    return (
      <div className="lim-compact" aria-label="Limits">
        <span className="eyebrow">Limits</span>
        {accounts.map((a) => {
          const ws = Object.entries(a.windows)
          return (
            <span className="lim-chip" key={a.account}>
              <b>{a.account}</b>
              {ws.length ? ws.map(([w, win]) => {
                const f = forecast(win, a.shares?.[w], a.stale)
                const hit = paceLines(a.shares?.[w], a.stale).find((l) => l.hitAt)
                return <span key={w} className={tone(f) || hit ? 'lim-warn' : ''}>{label(w)} {f.used}%{hit?.hitAt ? ` · ${hit.label} 100% ≈ ${timeOf(hit.hitAt)}` : ''}</span>
              }) : <span className="muted">{a.balance != null ? `${m(a.balance)} left` : 'no reading'}</span>}
              {a.stale ? <span className="lim-warn">stale</span> : null}
            </span>
          )
        })}
      </div>
    )
  }
  return (
    <section className="lim-band">
      <div className="eyebrow">Limits</div>
      <BudgetSplit accounts={accounts} reserve={reserve} />
      <div className="lim-cards">{accounts.filter((a) => a.account !== SYSTEM_ACCOUNT).map((a) => <AccountCard key={a.account} a={a} allocations={allocations} split={a.account === AGENTS_ACCOUNT} />)}</div>
    </section>
  )
}

// One hairline callout, a line per blocked agent with an Open link. Shown only when agents are blocked.
export function BlockedCallout({ rows }: { rows: BlockedAgent[] }) {
  if (!rows.length) return null
  return (
    <section className="lim-blocked mb-callout warning" aria-label="Blocked agents">
      {rows.map((b) => {
        const bl = b.blockers[0]
        return (
          <div className="lim-bline" key={b.agent_id}>
            <span className="mb-label">Blocked</span>
            <span><b>{b.agent}</b> {bl ? `${bl.account ? `${bl.kind} on ${bl.account}: ` : ''}${bl.reason}` : b.lifecycle}{b.paused_by.length ? ` · paused by ${b.paused_by.join(', ')}` : ''}</span>
            <button type="button" className="btn text" onClick={() => openAgent(b.agent_id)}>Open</button>
          </div>
        )
      })}
    </section>
  )
}
