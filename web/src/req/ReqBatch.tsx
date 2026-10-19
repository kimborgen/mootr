// The drafts in a batch approval ITSA (kind `requirement-approval`, one ask for several drafts):
// each one with its text and why, and Drop to take it out of the batch. Dropping offers two
// choices: keep it a draft (the first) or mark it obsolete (the second). Approve, under Waiting on
// you, then puts the rest in force. Shown while requirements are on, for an open batch only.
import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Itsa } from '../types'
import type { ReqStatus } from './model'
import { openReq } from './parts'
import { refreshReq, useReq } from './store'

export interface BatchItem {
  key: string
  title: string
  text: string | null
  rationale: string | null
  rev: number
  status: ReqStatus
  dropped: boolean
}

interface BatchView { itsa: string; items: BatchItem[] }

// `onBatch` says whether this ask is a batch with drafts to list, so the ITSA hides its body (the same list).
export function ReqBatch({ it, onBatch }: { it: Pick<Itsa, 'id' | 'kind' | 'closed_at' | 'updated_at'>; onBatch?: (batch: boolean) => void }) {
  const { enabled } = useReq()
  const [items, setItems] = useState<BatchItem[] | null>(null)
  const [picking, setPicking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const batch = enabled && it.kind === 'requirement-approval'
  // Reloads when the ITSA changes (a draft edited, an Approve refused and refreshed).
  useEffect(() => {
    // Off, or not a batch: nothing is listed, so the ITSA shows its own body again.
    if (!batch) { onBatch?.(false); return }
    let live = true
    api<BatchView>('GET', `/api/requirements/asks/${it.id}`)
      .then((r) => { if (live) { setItems(r.items); onBatch?.(r.items.length > 0) } })
      .catch(() => { if (live) { setItems([]); onBatch?.(false) } }) // a single-draft ask has no batch: nothing to list
    return () => { live = false }
  }, [batch, it.id, it.updated_at])

  if (!batch || !items?.length) return null
  const open = !it.closed_at
  // The rev shown goes with the drop: a draft that changed since, or was approved, refuses it.
  const drop = async (x: BatchItem, obsolete: boolean) => {
    setError(null)
    try {
      const r = await api<BatchView>('POST', `/api/requirements/asks/${it.id}/drop`, { key: x.key, obsolete, if_rev: x.rev })
      setItems(r.items)
      setPicking(null)
      void refreshReq()
    } catch (e) { setError((e as Error).message) }
  }
  const left = items.filter((x) => !x.dropped).length
  const dropped = items.length - left
  return (
    <section className="itsa-sec rq-batch-sec" aria-label="Drafts in this batch" data-req-batch>
      <div className="itsa-sec-head"><span className="eyebrow">Drafts in this batch</span><span className="count">{left} to approve{dropped ? `, ${dropped} dropped` : ''}</span></div>
      <ul className="rq-batch">{items.map((x) => (
        <li key={x.key} className={'rq-batch-row' + (x.dropped ? ' dropped' : '')} data-batch-item={x.key}>
          <div className="rq-batch-text">
            <button type="button" className="rq-batch-head" onClick={() => openReq(x.key)} title={`${x.key} · ${x.title}`}>
              <span className="ikey">{x.key}</span><span className="ititle">{x.title}</span>
            </button>
            {x.text ? <p className="rq-batch-shall">{x.text}</p> : null}
            {x.rationale ? <p className="rq-batch-why muted"><b>Why:</b> {x.rationale}</p> : null}
          </div>
          {x.dropped ? <span className="rq-batch-state muted">{x.status === 'obsolete' ? 'Dropped, now obsolete' : 'Dropped, still a draft'}</span>
            : !open ? null
            : picking === x.key ? (
              <div className="rq-batch-pick" role="group" aria-label={`Drop ${x.key}`}>
                <button type="button" className="btn" data-drop-keep={x.key} onClick={() => void drop(x, false)}>Keep as draft</button>
                <button type="button" className="btn" data-drop-obsolete={x.key} onClick={() => void drop(x, true)}>Mark obsolete</button>
                <button type="button" className="btn text" onClick={() => setPicking(null)}>Cancel</button>
              </div>
            ) : <button type="button" className="btn" data-drop={x.key} onClick={() => setPicking(x.key)}>Drop</button>}
        </li>))}</ul>
      {error ? <p className="rq-batch-error" role="alert">{error}</p> : null}
    </section>
  )
}
