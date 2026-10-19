// The quick filters' toggle chips (S-1515): the "Quick" row under the Work bar on the desktop, and
// the row that scrolls sideways under the phone glance's bar. One button per preset, pressed when
// on; they AND with each other and with the column filters, and the layout keeps which are on.
import { QUICK, type QuickId } from './quick'

export function QuickBar({ on, onToggle, className = '', children }: { on: QuickId[] | undefined; onToggle: (id: QuickId) => void; className?: string; children?: React.ReactNode }) {
  return <div className={'w-quick ' + className} role="group" aria-label="Quick filters">
    <span className="w-qlabel">Quick</span>
    {QUICK.map((q) => {
      const pressed = (on ?? []).includes(q.id)
      return <button key={q.id} type="button" className={'w-qchip' + (pressed ? ' on' : '')} data-quick={q.id} aria-pressed={pressed} title={q.hint} onClick={() => onToggle(q.id)}>{q.label}</button>
    })}
    {children}
  </div>
}
