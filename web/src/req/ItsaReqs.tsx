// An ITSA's "Requirements" panel, shown while requirements are on and some are linked to it:
// each linked requirement with its role and its latest verdict on the ITSA, as an indication.
import type { Itsa } from '../types'
import { linkedTo, stateOf, STATUS_WORD, verdictWord, WAIVER_WORD } from './model'
import { openReq, ReqGlyph } from './parts'
import { useReq, useReqReader } from './store'

export function ItsaReqs({ it }: { it: Pick<Itsa, 'id' | 'key'> }) {
  const { enabled, reqs } = useReq()
  useReqReader()
  if (!enabled) return null
  const rows = linkedTo(it, reqs)
  if (!rows.length) return null
  return (
    <section className="itsa-sec" aria-label="Requirements" data-itsa-reqs>
      <div className="itsa-sec-head"><span className="eyebrow">Requirements</span><span className="count">{rows.length}</span></div>
      <div className="itsa-kids">{rows.map(({ req, role, verdict }) => (
        <button type="button" key={req.id} className={'ikid' + (req.status !== 'in_force' ? ' closed' : '')} data-req={req.key} onClick={() => openReq(req.key)} title={`${req.key} · ${req.title} · ${STATUS_WORD[req.status]}`}>
          <ReqGlyph state={verdict && !verdict.waived ? stateOf([verdict]) : 'unverified'} status={req.status} />
          <span className="ikey">{req.key}</span><span className="ititle">{req.title}</span>
          <span className="ikid-meta"><span className="muted">{role.replace(/_/g, ' ')}</span>
            <span className={`st rq-word ${verdict?.verdict ?? ''}`}>{!verdict ? 'not checked here' : verdict.waived ? WAIVER_WORD[verdict.waived] : verdictWord(verdict.verdict, verdict.verdict === 'violates' ? verdict.p_violates : null)}</span></span>
        </button>))}</div>
    </section>
  )
}
