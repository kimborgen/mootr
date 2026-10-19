// A list's or a pane's first load: the stam logo at work, standing where the empty state would,
// so the view doesn't jump when the rows arrive (S-1451, by Kim's ask; docs/design-system.md,
// "Empty, loading, and error"). An accent arc runs round the logo's ring while the bot bobs and
// blinks. Each part is its own small layer moved by transform alone, so the loop stays on the
// compositor while the page fetches. It fades in only after --duration-hold, so a fast load
// shows nothing; reduced motion swaps the movement for a slow breathe of the arc.
export function Loading({ className = 'pad muted', size = 'sm', label = 'Loading' }: { className?: string; size?: 'sm' | 'lg'; label?: string }) {
  return (
    <div className={className} role="status" aria-label={label}>
      <StamLoader size={size} />
    </div>
  )
}

// The logo's geometry, from web/public/icon.svg: a ring of r 148 round the Lucide bot, on a 512 grid.
const BOT = 'translate(160 160) scale(8)'

export function StamLoader({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <span className={'stam-loader' + (size === 'lg' ? ' lg' : '')} aria-hidden="true">
      <svg className="stam-loader-track" viewBox="0 0 512 512"><circle cx="256" cy="256" r="148" /></svg>
      <svg className="stam-loader-arc" viewBox="0 0 512 512"><circle cx="256" cy="256" r="148" pathLength="100" /></svg>
      <span className="stam-loader-bot">
        <svg viewBox="0 0 512 512"><g transform={BOT}><path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /></g></svg>
        <svg className="stam-loader-eyes" viewBox="0 0 512 512"><g transform={BOT}><path d="M15 13v2" /><path d="M9 13v2" /></g></svg>
      </span>
    </span>
  )
}
