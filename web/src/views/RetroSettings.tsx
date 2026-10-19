// Settings › Retros: the self-retro loop (S-708). The weekly digest (on, day, hour), the retro
// steward, the reminders agents get, the epic retro offer, and a link to the Retros page.
// Each control writes its own sub-key through ConfigView's deep-path setter (`retro.digest.day`,
// `retro.steward.enabled`, …), so a change to one keeps the others even while an earlier save is
// still in flight: a page that handed back a whole `retro` object built from a stale render would
// drop them. `lastDigest` is the daemon's own; the page never sends its copy, and shows the
// daemon's value (`lastDigest`, read from ConfigView's base) rather than the page's stale one.
import { useState } from 'react'
import { ago } from '../format'
import { Icon } from '../Icon'
import { openItsa } from '../itsa/itsa'
import { useData } from '../store'

export interface Retro {
  digest?: { enabled?: boolean; day?: string; hour?: number }
  lastDigest?: string | null
  steward?: { enabled?: boolean }
  // The reminder in context warnings, compaction, and shutdown notices; a missing value is on.
  reminders?: { enabled?: boolean }
  epic?: { minReporters?: number; maxWindowShare?: number }
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

const DAYS = [
  { v: 'daily', label: 'Every day' },
  { v: 'mon', label: 'Mondays' }, { v: 'tue', label: 'Tuesdays' }, { v: 'wed', label: 'Wednesdays' }, { v: 'thu', label: 'Thursdays' },
  { v: 'fri', label: 'Fridays' }, { v: 'sat', label: 'Saturdays' }, { v: 'sun', label: 'Sundays' },
]
const HOURS = Array.from({ length: 24 }, (_, h) => h)

function Row({ label, help, children }: { label: string; help: string; children: React.ReactNode }) {
  return <div className="set-row"><div className="set-label"><b>{label}</b><p>{help}</p></div><div className="set-ctl">{children}</div></div>
}

// A whole number saved when the field is left (or on Enter), clamped to min and max; an empty or
// invalid entry goes back to the saved value.
function Whole({ label, value, min, max, unit, disabled, onValue }: { label: string; value: number; min: number; max: number; unit?: string; disabled: boolean; onValue: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const n = Math.round(Number(draft))
    setDraft(null)
    if (draft !== null && draft !== '' && Number.isFinite(n) && n !== value) onValue(Math.min(max, Math.max(min, n)))
  }
  return (
    <span className="num">
      <input type="number" aria-label={label} min={min} max={max} step={1} disabled={disabled} value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
      {unit ? <span className="unit">{unit}</span> : null}
    </span>
  )
}

export function RetroSettings({ retro, lastDigest, disabled = false, why, set }: { retro: Retro; lastDigest?: string | null; disabled?: boolean; why?: string; set: (path: string, v: Json) => void }) {
  const { itsas } = useData()
  const page = itsas.find((x) => x.kind === 'retros')
  const digest = { enabled: true, day: 'daily', hour: 9, ...retro.digest }
  const epic = { minReporters: 3, maxWindowShare: 50, ...retro.epic }
  const title = disabled ? why : undefined
  const check = (label: string, on: boolean, set: (v: boolean) => void) => (
    <label className="check" title={title}><input type="checkbox" disabled={disabled} checked={on} onChange={(e) => set(e.target.checked)} />{label}</label>
  )
  return (
    <>
      <p className="lede">Agents report what slowed them down or worked well as retro items. mootr collects them in a digest for the Retros owner (or the chief of staff), and a steward can turn them into instruction edits.</p>
      <div className="set-card">
        <Row label="Retros page" help="The open retro items, ranked by +1s, and who spends the effort.">
          <button type="button" className="btn" disabled={!page} title={page ? undefined : 'No Retros page yet: it appears with the first retro item.'} onClick={() => page && openItsa(page.id)}>Open Retros<Icon name="arrow-right" size="xs" /></button>
        </Row>
      </div>
      <h3>Digest</h3>
      <div className="set-card">
        <Row label="Send the digest" help="Mail the owner of the Retros ITSA (or the chief of staff) a digest of the new retro items.">{check('On', digest.enabled, (v) => set('retro.digest.enabled', v))}</Row>
        <Row label="Day" help="Every day, or one weekday.">
          <select aria-label="Digest day" disabled={disabled} title={title} value={digest.day} onChange={(e) => set('retro.digest.day', e.target.value)}>
            {DAYS.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
          </select>
        </Row>
        <Row label="Hour" help="Local time on the ITSA home machine.">
          <select aria-label="Digest hour" disabled={disabled} title={title} value={digest.hour} onChange={(e) => set('retro.digest.hour', Number(e.target.value))}>
            {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
          </select>
        </Row>
        <Row label="Last digest" help="When this machine last sent one, or found nothing to send. Kept on this machine."><span className="chip scope-tag">This machine</span><span className="muted">{lastDigest ? ago(lastDigest) : 'Never'}</span></Row>
      </div>
      <h3>Loop</h3>
      <div className="set-card">
        <Row label="Retro steward" help="After each digest, a steward agent proposes edits to the instructions.">{check('On', retro.steward?.enabled !== false, (v) => set('retro.steward.enabled', v))}</Row>
        <Row label="Reminders" help="Agents are reminded to file a retro in context warnings, before compaction, and at shutdown.">{check('On', retro.reminders?.enabled !== false, (v) => set('retro.reminders.enabled', v))}</Row>
      </div>
      <h3>Epic retro</h3>
      <div className="set-card">
        <Row label="Reporters needed" help="A closed project or initiative gets a retro offer when its retro items come from at least this many agents.">
          <Whole label="Reporters needed" value={epic.minReporters} min={1} max={999} disabled={disabled} onValue={(n) => set('retro.epic.minReporters', n)} />
        </Row>
        <Row label="Window share limit" help="The offer is made only while the tree has used less than this share of the 5-hour window.">
          <Whole label="Window share limit" value={epic.maxWindowShare} min={0} max={100} unit="%" disabled={disabled} onValue={(n) => set('retro.epic.maxWindowShare', n)} />
        </Row>
      </div>
    </>
  )
}
