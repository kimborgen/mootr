// The prompt input's recipient menu: the body of the popover the stam icon opens. "Write to" picks who
// the box sends to (the current agent, its parent, intake, cos, the assistant: the ones that exist);
// "cc" adds or removes any live agent, searchable. It reads the box's state through a store, since the
// popover's body is rendered by the menu layer, outside the box.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Icon } from './Icon'
import { Glyph } from './Glyph'
import { assistant, chiefAssistants, chiefsOfStaff, getData, useData } from './store'
import { live } from './format'
import { kindIcon } from './CcPills'
import type { CcItem } from './cc-pills'

export interface Recip { id: string | null; name: string; tag: string; glyph: ReactNode }
export interface RecipSnap {
  recips: Recip[]
  // The chosen recipient: null is the box's own target.
  picked: string | null
  cc: string[]
  // cc only means something where the message goes as mail.
  ccOk: boolean
  // The agent the box's own target mails; the one id that is never a cc.
  to?: string
  pick: (id: string | null) => void
  toggle: (id: string) => void
  // Threads and the ITSA picked from the cc pills (S-1464), and how to drop one.
  items?: CcItem[]
  drop?: (id: string) => void
}
export interface RecipStore { get: () => RecipSnap; subscribe: (fn: () => void) => () => void }
export const makeRecipStore = (): RecipStore & { set: (s: RecipSnap) => void } => {
  let snap: RecipSnap
  const ls = new Set<() => void>()
  return { get: () => snap, subscribe: (fn) => { ls.add(fn); return () => { ls.delete(fn) } }, set: (s) => { snap = s; for (const fn of ls) fn() } }
}

const MAX_HITS = 8
export function RecipientMenu({ store }: { store: RecipStore }) {
  useData()
  const s = useSyncExternalStore(store.subscribe, store.get)
  const [q, setQ] = useState('')
  const root = useRef<HTMLDivElement>(null)
  // Focus lands on the current choice, so Enter right away keeps it and the arrows move from it.
  useEffect(() => { root.current?.querySelector<HTMLButtonElement>('button[aria-checked=true]')?.focus() }, [])
  const asst = assistant()
  const recipient = s.picked === null ? s.to : s.picked === 'assistant' ? asst?.id : s.picked
  const quick = [chiefsOfStaff()[0], chiefAssistants()[0], asst].filter((a): a is NonNullable<typeof a> => !!a && a.id !== recipient)
  const needle = q.trim().toLowerCase()
  const all = getData().agents.filter((a) => live(a) && a.id !== recipient)
  const picked = s.cc.map((id) => all.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a)
  const rows = needle
    ? all.filter((a) => a.name.toLowerCase().includes(needle) || (a.role ?? '').toLowerCase().includes(needle)).slice(0, MAX_HITS)
    : [...picked, ...quick.filter((a) => !s.cc.includes(a.id))]
  return (
    <div className="rm" ref={root}>
      <div className="label eyebrow">Write to</div>
      <div role="radiogroup" aria-label="Write to">
        {s.recips.map((r) => (
          <button key={r.id ?? 'current'} type="button" role="radio" aria-checked={s.picked === r.id} className="rm-row" onClick={() => s.pick(r.id)}>
            {r.glyph}<span className="ml"><b>{r.name}</b> <span className="muted">{r.tag}</span></span>
            <span className={'tick' + (s.picked === r.id ? '' : ' off')}><Icon name="check" /></span>
          </button>
        ))}
      </div>
      {s.ccOk
        ? <>
            <div className="label eyebrow">cc</div>
            <input className="rm-search" value={q} placeholder="Find an agent" aria-label="Find an agent to cc" onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && rows[0]) { e.preventDefault(); s.toggle(rows[0].id); setQ('') } }} />
            <div className="rm-list" role="group" aria-label="Also send to">
              {needle ? null : (s.items ?? []).map((x) => (
                <button key={x.kind + ':' + x.id} type="button" role="checkbox" aria-checked className="rm-row rm-cc" data-cc-item={x.kind + ':' + x.id} onClick={() => s.drop?.(x.id)}
                  title={x.kind === 'itsa' ? 'Filed on this ITSA; click to remove' : 'Its participants get it; click to remove'}>
                  <span className="pal-ico">{kindIcon(x)}</span><span className="ml"><b>{x.title}</b><span className="muted"> · {x.kind === 'itsa' ? 'filed on it' : `${x.people.length} in the thread`}</span></span>
                  <span className="tick"><Icon name="check" /></span>
                </button>
              ))}
              {rows.map((a) => (
                <button key={a.id} type="button" role="checkbox" aria-checked={s.cc.includes(a.id)} className="rm-row rm-cc" onClick={() => { s.toggle(a.id); setQ('') }}>
                  <Glyph agent={a} /><span className="ml"><b>{a.name}</b>{a.role ? <span className="muted"> · {a.role.slice(0, 40)}</span> : null}</span>
                  <span className={'tick' + (s.cc.includes(a.id) ? '' : ' off')}><Icon name="check" /></span>
                </button>
              ))}
              {needle && !rows.length ? <div className="rm-none muted">No agent matches</div> : null}
            </div>
          </>
        : null}
    </div>
  )
}
