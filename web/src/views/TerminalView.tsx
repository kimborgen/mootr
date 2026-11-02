// An agent's terminal or a plain terminal, as a view: mounts a TermSession and keeps it in
// step with the agent (it connects while the agent runs and reconnects after a restart).
// S-4751: it is attached only while on screen. A tab in the background, a pane a phone doesn't
// show, another world's view, or a hidden browser tab disconnects, so nothing streams a pane nobody looks at; showing
// it again reattaches, and tmux redraws the screen (the scrollback it missed is gone).
import { useEffect, useRef } from 'react'
import { registerView, useViewShown } from '../shell/layout'
import { useData } from '../store'
import { TermSession, type TermKey } from '../term/TermSession'
import type { PlainShell } from '../types'

export function TerminalView({ viewKey, id, sh }: { viewKey: string; id: string; sh?: PlainShell }) {
  const host = useRef<HTMLDivElement>(null)
  const session = useRef<TermSession | null>(null)
  const { agents } = useData()
  useEffect(() => {
    const s = new TermSession(id, sh)
    session.current = s
    host.current!.append(s.el)
    const un = registerView(viewKey, {
      show: () => s.show(),
      hide: () => s.hide(),
      focus: () => s.focus(),
      resize: () => s.resize(),
      key: (name) => s.key(name as TermKey),
      blur: () => s.blur(),
      // Closing a plain terminal's tab ends its shell.
      beforeClose: () => {
        if (!s.sh || s.ended) return true
        if (!confirm('Close this terminal? Its shell ends.')) return false
        s.kill()
        return true
      },
    })
    // A new view shows once it's in its pane.
    const raf = requestAnimationFrame(() => s.show())
    return () => { cancelAnimationFrame(raf); un(); s.destroy(); session.current = null }
  }, [viewKey, id])
  useEffect(() => { session.current?.sync() }, [agents])
  // A hidden browser tab is TermSession's own check (pageHidden).
  const shown = useViewShown(viewKey)
  useEffect(() => { if (shown) session.current?.show(); else session.current?.hide() }, [shown])
  return <div ref={host} style={{ display: 'contents' }} />
}
