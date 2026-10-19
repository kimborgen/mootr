import { openFromMail, StatusGlyph, statusLabel } from '../itsa/itsa'
import type { MailItsa } from '../types'

// The ITSAs a mail or thread is linked to (S-986), as chips that open the ITSA. `compact` shows the key
// and status glyph alone, for the row under a message's header; the thread header also shows the title.
export function ItsaChips({ items, compact, className, label, max, onMore }: { items: Pick<MailItsa, 'id' | 'key' | 'title' | 'status'>[]; compact?: boolean; className: string; label: string; max?: number; onMore?: () => void }) {
  if (!items.length) return null
  // With `max`, the rest fold into one "+N" chip of the same size, which `onMore` answers (the thread header lists them all).
  const shown = max !== undefined && items.length > max ? items.slice(0, max) : items
  const rest = items.length - shown.length
  return (
    <div className={className} aria-label={label}>{shown.map((x) => (
      <button key={x.id} type="button" className={'ichip-mail' + (compact ? ' compact' : '')} data-about-itsa={x.id} title={`${x.key} ${x.title} · ${statusLabel(x.status)}: open it`} onClick={(e) => { e.stopPropagation(); openFromMail(x.id, e.currentTarget) }}>
        <StatusGlyph status={x.status} /><span className="k">{x.key}</span>{compact ? null : <span className="t">{x.title}</span>}</button>))}
      {rest ? <button type="button" className="ichip-mail compact more" data-more-itsas title={`${rest} more linked ITSA${rest > 1 ? 's' : ''}: show them in the thread header`} onClick={(e) => { e.stopPropagation(); onMore?.() }}>+{rest}</button> : null}</div>
  )
}
