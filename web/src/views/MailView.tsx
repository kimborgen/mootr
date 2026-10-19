// An agent's inbox, as a tab in its world: its threads on the left, one on the right.
// Viewing an agent's mail leaves it unread, so the agent still gets it.
import { useEffect, useRef, useState } from 'react'
import { selectThread } from '../actions'
import { api } from '../api'
import { ago, baseSubject, threadTitle } from '../format'
import { Icon } from '../Icon'
import { Loading } from '../Loading'
import * as mb from '../mail/mailblocks'
import { Avatar, nameFor, ThreadPanel } from '../mail/ThreadPanel'
import { registerView } from '../shell/layout'
import { byId, useData } from '../store'
import type { Thread } from '../types'

export function MailView({ owner, viewKey }: { owner: string; viewKey: string }) {
  const { mailTick } = useData()
  const [threads, setThreads] = useState<Thread[]>([])
  const [error, setError] = useState<string | null>(null)
  // Until the first list lands, the empty state would say "No mail yet." about mail not yet fetched.
  const [loaded, setLoaded] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [freshFor, setFreshFor] = useState<{ tid: string; n: number; unread: string[] } | null>(null)
  const sig = useRef<string | null>(null)
  const human = owner === 'human'

  const load = async () => {
    let ts: Thread[]
    try { ts = await api<Thread[]>('GET', `/api/agents/${owner}/threads?limit=60`) } catch (e) { setError((e as Error).message); return }
    const s = JSON.stringify(ts.map((t) => t.mails.map((m) => [m.id, m.recipients.map((r) => r.read_at)])))
    if (s === sig.current) return
    sig.current = s
    setError(null)
    setThreads(ts)
    setLoaded(true)
  }
  useEffect(() => { sig.current = null; setLoaded(false) }, [owner])
  useEffect(() => { load() }, [owner, mailTick])
  useEffect(() => registerView(viewKey, { show: () => load() }), [viewKey])

  const unreadIn = (t: Thread) => t.mails.filter((m) => m.recipients.some((r) => r.id === owner && !r.read_at))
  const open = (t: Thread) => {
    setSel(t.thread_id)
    setReading(true)
    setFreshFor({ tid: t.thread_id, n: (freshFor?.n ?? 0) + 1, unread: unreadIn(t).map((m) => m.id) })
  }
  const t = threads.find((x) => x.thread_id === sel)
  const who = human ? 'Mail agents sent you.' : `Threads ${byId(owner)?.name ?? 'this agent'} takes part in. Reading them here leaves them unread for the agent.`
  return (
    <div className={'mail-view' + (reading ? ' reading' : '')}>
      <div className="mail-list">
        {error ? <div className="pad muted">{error}</div> : <>
          <div className="mail-head muted">{who}</div>
          {threads.length ? threads.map((th) => <Row key={th.thread_id} t={th} owner={owner} sel={th.thread_id === sel} unread={unreadIn(th).length} onClick={() => open(th)} />) : loaded ? <div className="pad muted">No mail yet.</div> : <Loading />}
        </>}
      </div>
      {t ? <ThreadPanel className="mail-read" mails={t.mails} threadKey={`${t.thread_id}:${freshFor?.n ?? 0}`} unread={freshFor?.unread}
          head={<div className="thread-actions"><button className="btn back" onClick={() => { setReading(false); setSel(null); sig.current = null; load() }}><Icon name="chevron-right" size="xs" />Inbox</button><span className="spacer" /><button className="btn" onClick={() => selectThread(sel)}><Icon name="reply" />Open to reply</button></div>} />
        : <div className="mail-read">{threads.length || loaded ? <div className="empty-pane"><p>{threads.length ? 'Pick a thread.' : 'No mail yet.'}</p></div> : null}</div>}
    </div>
  )
}

function Row({ t, owner, sel, unread, onClick }: { t: Thread; owner: string; sel: boolean; unread: number; onClick: () => void }) {
  const last = t.mails.at(-1)!, first = t.mails[0], title = threadTitle(t.mails)
  const people = [...new Set(t.mails.flatMap((m) => [m.from_id, ...m.recipients.map((r) => r.id)]))].filter((id) => id !== owner)
  const names = people.length > 3 ? `${people.slice(0, 2).map((id) => nameFor(id)).join(', ')} +${people.length - 2}` : people.map((id) => nameFor(id)).join(', ')
  return (
    <div className={`thread-item ${unread ? 'unread' : ''} ${sel ? 'sel' : ''}`} data-thread={t.thread_id} onClick={onClick}>
      <div className="top"><Avatar id={last.from_id} /><span className="from">{names || 'only this mailbox'}</span>{t.mails.length > 1 ? <span className="badge n">{t.mails.length}</span> : null}<span className="when">{ago(last.created_at)}</span></div>
      <div className="subj">{title ? <span className="chip mtitle">{title}</span> : null}{baseSubject(first.subject)}</div>
      <div className="snip"><b>{nameFor(last.from_id, last.from_name)}:</b> {mb.preview(last.body)}</div>
    </div>
  )
}
