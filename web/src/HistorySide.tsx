// The sidebar's history tab (S-1456): the things shown in main, newest on top, with the one showing
// marked. A row jumps there as back or forward that many times would (nav-history.ts); the list
// stays. A thing that no longer exists is dimmed and can't be opened. Kept per browser tab, with
// no persistence.
import { useSyncExternalStore } from 'react'
import { worldAlive } from './history-alive'
import { Icon } from './Icon'
import type { HistoryState } from './history-model'
import { historyState, jumpToEntry, onHistoryChange } from './nav-history'
import { useShell } from './shell/layout'
import { useData } from './store'
import { viewMeta } from './views/registry'

const metaOf = (w: string) => viewMeta(w.startsWith('t:') ? 'thread:' + w.slice(2) : w.startsWith('w:') ? w.slice(2) : 'agent:' + w)

// `state` is for the stories, which draw a list that nothing visited.
export function HistorySide({ bare, state }: { bare?: boolean; state?: HistoryState }) {
  const live = useSyncExternalStore(onHistoryChange, historyState)
  const h = state ?? live
  useShell()
  useData()
  return (
    <div className={'history-side' + (bare ? ' bare' : ' mail-side in-pane')} id="history-side">
      {bare ? null : <div className="section eyebrow"><Icon name="clock" size="xs" />History<span className="count">{h.entries.length || ''}</span></div>}
      <div className="mail-side-list">
        {h.entries.length ? h.entries.map((e, i) => ({ e, i })).reverse().map(({ e, i }) => {
          const m = metaOf(e.key)
          const dead = !worldAlive(e.key)
          const open = () => { if (!dead) jumpToEntry(i) }
          return <div key={i} className={'mrow' + (i === h.marker ? ' sel' : '') + (dead ? ' dead' : '')} data-history={e.key} role="button" tabIndex={0}
            aria-current={i === h.marker ? 'true' : undefined} aria-disabled={dead || undefined}
            title={dead ? `${m.title} no longer exists` : m.title}
            onClick={open} onKeyDown={(ev) => { if (ev.key === 'Enter') open() }}>
            {m.icon}<span className="s">{m.title}</span>
            {dead ? <span className="t">gone</span> : null}
          </div>
        }) : <div className="mail-empty muted">Where you go shows here.</div>}
      </div>
    </div>
  )
}
