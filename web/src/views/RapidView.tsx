// The conversation view's rapid-fire mode (S-1004): each thread between you and the agent as a
// mail card, oldest at the top and the newest at the bottom, by the prompt input that sends the
// next one. A tap picks a card: the prompt input then follows up in its thread, send after send,
// until a second tap, its ✕, or Esc unpicks it. ↑ in an empty prompt input picks the newest card.
// The picked card offers Open, which shows the whole thread. The list is the agent's threads from
// the daemon (`with=ID`), so old ones stay reachable: Load older threads fetches 60 more per box.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { selectThread } from '../actions'
import { Icon } from '../Icon'
import { MailCard } from '../mail/MailCard'
import { byId, rapidOlder, useData, watchRapid } from '../store'
import { activeIn } from '../shell/layout'
import { getPick, pickOf, rapidKey, rapidThreads, setPick, usePick } from './rapid'

export function RapidView({ id }: { id: string }) {
  const d = useData()
  const name = byId(id)?.name ?? 'the agent'
  const threads = useMemo(() => rapidThreads(id, d), [id, d.humanThreads, d.humanArchived, d.humanDeferred, d.rapidWith])
  const more = !!d.rapidWith?.[id]?.more
  const [loading, setLoading] = useState(false)
  useEffect(() => watchRapid(id), [id])
  const pick = usePick(id)
  const root = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  // A new card (one you just sent) comes into sight at the bottom.
  // Older threads loaded above keep what you were reading where it was. The anchor lasts for the
  // load only: a load that adds no card leaves none behind for the next send.
  const above = useRef<{ h: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = scroll.current
    if (!el) return
    const a = above.current
    el.scrollTop = a ? a.top + (el.scrollHeight - a.h) : el.scrollHeight
    above.current = null
  }, [threads.length])
  useLayoutEffect(() => { if (!loading) above.current = null }, [loading])
  // The picked card comes fully into sight: picking it adds Open beside it, which can rewrap it.
  useLayoutEffect(() => {
    const el = pick && [...scroll.current?.querySelectorAll<HTMLElement>('[data-card]') ?? []].find((x) => x.dataset.card === pick.thread_id)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [pick?.thread_id])
  const newest = useRef(threads.at(-1))
  newest.current = threads.at(-1)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !root.current?.offsetParent) return
      const box = e.target as HTMLElement | null
      const emptyBox = box instanceof HTMLTextAreaElement && !box.value && !!box.closest('#w-bottom')
      const act = rapidKey(e.key, { id, active: activeIn('main'), picked: !!getPick(id), emptyBox, cards: newest.current ? 1 : 0 })
      if (!act) return
      e.preventDefault()
      setPick(id, act === 'unpick' ? null : pickOf(newest.current!, id))
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [id])
  return (
    <div className="rf" ref={root} data-rapid={id}>
      <div className="rf-scroll" ref={scroll}>
        <div className="rf-col">
          <p className="rf-help" role="status">{pick
            ? <>Following up in the picked thread. Pick it again, or press Esc, to start new threads.</>
            : <>Each send starts a new thread to {name}. Tap a card to follow up in it.</>}</p>
          {more ? <button className="btn rf-older" type="button" disabled={loading}
            onClick={() => { above.current = scroll.current ? { h: scroll.current.scrollHeight, top: scroll.current.scrollTop } : null; setLoading(true); void rapidOlder(id).finally(() => setLoading(false)) }}>{loading ? 'Loading…' : 'Load older threads'}</button> : null}
          {threads.length ? null : <p className="ov-start">No mail with {name} yet.</p>}
          <ol className="rf-list" aria-label={`Threads with ${name}`}>
            {threads.map((t) => {
              const on = pick?.thread_id === t.thread_id
              return (
                <li key={t.thread_id} className={on ? 'on' : undefined}>
                  <MailCard thread={t} side="sent" selected={on} onTap={() => setPick(id, on ? null : pickOf(t, id))} />
                  {on ? <button className="icon-btn rf-open" type="button" data-open-thread title="Open the whole thread" aria-label="Open the whole thread"
                    onClick={() => selectThread(t.thread_id)}><Icon name="external-link" /></button> : null}
                </li>
              )
            })}
          </ol>
        </div>
      </div>
    </div>
  )
}
