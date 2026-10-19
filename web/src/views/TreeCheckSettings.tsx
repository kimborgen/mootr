// Settings › Chief of staff: the periodic tree check (S-915). When on, the daemon sends the chief of
// staff a recurring notice every N hours, carrying the checklist from the editable "tree-check"
// message (Settings › Messages stam sends). Each control writes its own sub-key through
// ConfigView's deep-path setter (`treeCheck.enabled`, `treeCheck.everyHours`).
import { useState } from 'react'

export interface TreeCheck { enabled?: boolean; everyHours?: number }
type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

function Row({ label, help, children }: { label: string; help: string; children: React.ReactNode }) {
  return <div className="set-row"><div className="set-label"><b>{label}</b><p>{help}</p></div><div className="set-ctl">{children}</div></div>
}

export function TreeCheckSettings({ treeCheck, disabled = false, why, set, onEdit }: { treeCheck: TreeCheck; disabled?: boolean; why?: string; set: (path: string, v: Json) => void; onEdit?: () => void }) {
  const cfg = { enabled: false, everyHours: 4, ...treeCheck }
  const [draft, setDraft] = useState<string | null>(null)
  const title = disabled ? why : undefined
  const commit = () => {
    const n = Number(draft)
    setDraft(null)
    if (draft !== null && draft !== '' && Number.isFinite(n) && n !== cfg.everyHours) set('treeCheck.everyHours', Math.min(168, Math.max(0.25, n)))
  }
  return (
    <>
      <p className="lede">The chief of staff looks over the agent tree and the machine on a schedule, and files a retro or an ITSA for each finding.</p>
      <div className="set-card">
        <Row label="Tree check" help="Send the chief of staff the checklist on a schedule. A change applies at once, without a restart.">
          <label className="check" title={title}><input type="checkbox" disabled={disabled} checked={cfg.enabled} onChange={(e) => set('treeCheck.enabled', e.target.checked)} />On</label>
        </Row>
        <Row label="Every" help="Hours between checks, from 0.25 to 168. May be fractional.">
          <span className="num">
            <input type="number" aria-label="Hours between tree checks" min={0.25} max={168} step={0.25} disabled={disabled} title={title} value={draft ?? cfg.everyHours}
              onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
            <span className="unit">hours</span>
          </span>
        </Row>
        <Row label="Checklist" help="The text the notice carries. Edit it with the other messages mootr sends.">
          <button type="button" className="btn" disabled={!onEdit} onClick={onEdit}>Edit checklist</button>
        </Row>
      </div>
    </>
  )
}
