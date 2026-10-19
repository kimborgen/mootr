// The tool calls an agent made on the way to a mail it sent (S-1643), drawn as one ToolGroup above the mail's card in
// the ITSA thread. Read from GET /api/agents/:id/view/tools?mail=ID when the card scrolls into view, newest first as the
// thread is read. An answer is kept per mail for the page's life. A refusal (404: no such mail; 409: no view, or the view
// is gone) is an answer too: nothing to draw, kept. Any other failure is a failed read, so its entry goes and the next
// view of the card reads again. `truncated`: the view ran out of pages before the turn's start, so the drawer says so.
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Mail } from '../types'
import { ToolGroup, type ToolCallItem } from './ToolGroup'

interface ToolsAnswer { tools: { id: string; name: string; input?: unknown; output?: string; status: ToolCallItem['status'] }[]; truncated?: boolean }
export interface MailToolsOf { tools: ToolCallItem[]; truncated: boolean }

const NOTHING: MailToolsOf = { tools: [], truncated: false }
const cache = new Map<string, Promise<MailToolsOf>>()
export function toolsOfMail(agent: string, mailId: string): Promise<MailToolsOf> {
  let p = cache.get(mailId)
  if (!p) {
    p = api<ToolsAnswer>('GET', `/api/agents/${agent}/view/tools?mail=${encodeURIComponent(mailId)}`).then(
      (r) => ({ tools: Array.isArray(r?.tools) ? r.tools.map((t) => ({ id: t.id, name: t.name, input: t.input, result: t.output, status: t.status })) : [], truncated: r?.truncated === true }),
      (e: { status?: number }) => {
        if (e?.status !== 404 && e?.status !== 409) cache.delete(mailId)
        return NOTHING
      },
    )
    cache.set(mailId, p)
  }
  return p
}

export function MailTools({ mail }: { mail: Mail }) {
  const [ans, setAns] = useState<MailToolsOf>(NOTHING)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    const load = () => { toolsOfMail(mail.from_id, mail.id).then((t) => { if (live) setAns(t) }) }
    const el = box.current
    if (typeof IntersectionObserver === 'undefined' || !el) { load(); return () => { live = false } }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      load()
    }, { rootMargin: '200px 0px' })
    io.observe(el)
    return () => { live = false; io.disconnect() }
  }, [mail.id, mail.from_id])
  return (
    <div ref={box}>
      {ans.tools.length ? <ToolGroup tools={ans.tools} agent={mail.from_id} /> : null}
      {ans.truncated ? <p className="muted">Earlier calls not shown</p> : null}
    </div>
  )
}
