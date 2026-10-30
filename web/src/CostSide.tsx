// The Cost tab of the sidebar panes (S-1423): one compact entry per subscription or API account stam
// manages. Line one is the account, its harness, and the cost figures it has (API-equivalent use,
// actual paid); line two is the 5-hour and 7-day meters, or for an API-only account its budget bar.
// A subscription with a budget gets the budget bar as a third line. Hovering an entry (a tap on a
// phone) opens the details: reset times, the forecast, this period's figures, and the budget.
import { useEffect, useState } from 'react'
import { api } from './api'
import { costEntries, type CostEntry, type CostWindow, LINE_WINDOWS } from './cost-side'
import { HARNESS } from './format'
import { Icon } from './Icon'
import { isPhone, useShell } from './shell/layout'
import { onUsageChanged } from './store'
import { hideMenu, showPopover } from './ui/menu'
import type { Account, Usage } from './usage/types'
import { m, timeOf, winLabel } from './usage/shared'

const WIN_SHORT: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
const short = (k: string) => WIN_SHORT[k] ?? winLabel(k)
const REFRESH_MS = 5 * 60_000
const MIN_GAP_MS = 30_000

// The accounts, read only while the pane shows: on show, on a usage change (at most every 30 s, a change
// inside the gap lands when it ends), when the page becomes visible, and every 5 minutes.
function useAccounts(shown: boolean): Account[] | null {
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  useEffect(() => {
    if (!shown) return
    let live = true
    let last = 0
    let later: number | undefined
    const run = () => {
      later = undefined
      last = Date.now()
      api<Usage>('GET', '/api/usage?days=1').then((u) => { if (live) setAccounts(u.accounts ?? []) }, () => { last = 0 })
    }
    const load = () => {
      if (document.hidden || later !== undefined) return
      const wait = MIN_GAP_MS - (Date.now() - last)
      if (wait <= 0) run(); else later = window.setTimeout(run, wait)
    }
    load()
    const off = onUsageChanged(load)
    const t = window.setInterval(load, REFRESH_MS)
    document.addEventListener('visibilitychange', load)
    return () => { live = false; off(); window.clearInterval(t); window.clearTimeout(later); document.removeEventListener('visibilitychange', load) }
  }, [shown])
  return accounts
}

function Meter({ w }: { w: CostWindow }) {
  const u = Math.max(0, Math.min(100, w.used))
  const hatch = w.atReset != null && w.atReset > u ? w.atReset - u : 0
  return (
    <span className="csd-win" data-tone={w.tone} role="img" aria-label={`${winLabel(w.key)} ${Math.round(w.used)}% used${w.atReset != null ? `, about ${Math.round(w.atReset)}% at reset` : ''}`}>
      <span className="cl" aria-hidden="true">{short(w.key)}</span>
      <span className="ctrack"><i className="fill" style={{ width: `${u}%` }} />{hatch > 0 ? <i className="proj" style={{ left: `${u}%`, width: `${hatch}%` }} /> : null}</span>
      <span className="cv" aria-hidden="true">{Math.round(w.used)}%</span>
    </span>
  )
}

function BudgetBar({ e }: { e: CostEntry }) {
  const b = e.budget!
  return (
    <span className="csd-budget" data-state={b.state} role="img" aria-label={`Budget ${b.pct != null ? Math.round(b.pct) + '% used' : 'spent unknown'}`}>
      <span className="ctrack"><i className="fill" style={{ width: `${b.pct ?? 0}%` }} /></span>
      <span className="cv">{b.spent != null ? m(b.spent) : '—'}/{m(b.usd)}</span>
    </span>
  )
}

function Details({ e, leave }: { e: CostEntry; leave: () => void }) {
  const b = e.budget
  return (
    <div className="machines-pop csd-pop" data-account={e.name} onMouseLeave={leave}>
      <div className="mp-head">
        <span className="eyebrow"><Icon name="gauge" size="xs" />{e.name}</span>
        <span className={'mp-state' + (e.stale ? ' off' : '')}>{e.stale ? 'stale reading' : HARNESS[e.harness] ?? e.harness}</span>
      </div>
      <dl className="mp-grid">
        {e.windows.map((w) => (
          <div key={w.key}>
            <dt>{short(w.key)}</dt>
            <dd>
              {Math.round(w.used)}% used{w.resetsAt ? ` · resets ${timeOf(w.resetsAt)}` : ''}
              {w.hitAt ? <><br />100% ≈ {timeOf(w.hitAt)}</> : w.atReset != null ? <><br />≈{Math.round(w.atReset)}% at reset</> : null}
              {w.rate != null ? <> · ≈{w.rate.toFixed(w.rate >= 10 ? 0 : 1)}%/h</> : null}
            </dd>
          </div>
        ))}
        {e.worth != null ? <div><dt>API</dt><dd>≈{m(e.worth)} API-equivalent this window</dd></div> : null}
        {e.paid != null ? <div><dt>Paid</dt><dd>{e.paidEstimate ? '≈' : ''}{m(e.paid)} this month</dd></div> : null}
        {b ? <div><dt>Budget</dt><dd>{b.spent != null ? m(b.spent) : '—'} of {m(b.usd)}/{b.per}{b.pct != null ? ` (${Math.round(b.pct)}%)` : ''}</dd></div> : null}
      </dl>
    </div>
  )
}

function Entry({ e, phone }: { e: CostEntry; phone: boolean }) {
  const leave = () => {
    window.setTimeout(() => {
      if (!document.querySelector('.csd-pop')?.matches(':hover')) hideMenu()
    }, 200)
  }
  const open = (el: Element) => {
    const r = el.getBoundingClientRect()
    showPopover(r.right + 4, r.bottom + 4, `${e.name} cost`, <Details e={e} leave={leave} />, el)
  }
  const line = LINE_WINDOWS.map((k) => e.windows.find((w) => w.key === k)).filter((w): w is CostWindow => !!w)
  const figures = [e.worth != null ? `≈${m(e.worth)} API` : '', e.paid != null ? `${e.paidEstimate ? '≈' : ''}${m(e.paid)} paid` : ''].filter(Boolean)
  return (
    <button type="button" className="csd-row" data-account={e.name} data-level={e.level} data-sub={e.subscription} aria-label={`${e.name} cost and limits`}
      onMouseEnter={phone ? undefined : (ev) => open(ev.currentTarget)}
      onMouseLeave={phone ? undefined : leave}
      onClick={phone ? (ev) => open(ev.currentTarget) : undefined}
      onKeyDown={phone ? undefined : (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(ev.currentTarget) } }}>
      <span className="csd-head">
        <span className="cname">{e.name}</span>
        <span className="cmark">{HARNESS[e.harness] ?? e.harness}</span>
        {e.stale ? <span className="cstale">stale</span> : null}
        {figures.length ? <span className="cfig">{figures.join(' · ')}</span> : null}
      </span>
      {line.length ? <span className="csd-meters">{line.map((w) => <Meter key={w.key} w={w} />)}</span> : null}
      {e.budget ? <BudgetBar e={e} /> : null}
    </button>
  )
}

// `shown`: the pane is on screen (its tab showing, the sidebar open). Hidden, it reads nothing.
export function CostSide({ shown = true }: { shown?: boolean }) {
  const accounts = useAccounts(shown)
  useShell()
  const phone = isPhone()
  const entries = costEntries(accounts ?? undefined)
  return (
    <div className="csd-side" id="cost-side">
      {accounts == null ? <p className="muted csd-empty">Loading…</p>
        : !entries.length ? <p className="muted csd-empty">No subscriptions or paid accounts yet.</p>
        : <div className="csd-list">{entries.map((e) => <Entry key={e.name} e={e} phone={phone} />)}</div>}
    </div>
  )
}
