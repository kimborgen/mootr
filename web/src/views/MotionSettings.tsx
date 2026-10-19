// Settings › Motion (S-696): a master toggle for all animation and one toggle per kind of motion
// (MOTION_KINDS in motion-gate.ts). All are on by default; the kind toggles are off-limits while
// the master is off. Saved in the human's settings, so they follow the user across devices. The system
// view is exempt and ignores them.
import { useEffect, useState } from 'react'
import { loadMotion, motionOn, MASTER, MOTION_KINDS, setMotion, subscribeMotion } from '../motion-gate'

export function MotionSettings() {
  const [, tick] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => {
    const off = subscribeMotion(() => tick((n) => n + 1))
    loadMotion().catch((e: Error) => setError(e.message))
    return off
  }, [])
  const master = motionOn(MASTER)
  // The whole row is the label, so on a phone the row is the touch target.
  const row = (id: string, label: string, help: string, off: boolean) => (
    <label key={id} className="set-row motion-row">
      <div className="set-label"><b>{label}</b><p>{help}</p></div>
      <div className="set-ctl"><span className="check"><input type="checkbox" disabled={off} checked={motionOn(id)} onChange={(e) => setMotion(id, e.target.checked)} />On</span></div>
    </label>
  )
  return (
    <div className="motion-set">
      <p className="lede">Which parts of the sidebar animate. The system view page ignores these settings. Animation also stays off while your device asks for reduced motion, while a row is off screen, and while its list is scrolling.</p>
      {error ? <p className="muted">{error}</p> : null}
      <div className="set-card">
        {row(MASTER, 'Animations', 'Turn all animation off or on.', false)}
        {MOTION_KINDS.map((k) => row(k.id, k.label, k.help, !master))}
      </div>
    </div>
  )
}
