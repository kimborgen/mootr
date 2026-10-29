// Markdown with every mail component (docs/mail-components.md), finished in place like a
// mail's: diagrams, code, math, charts, and thread links. Shared by the views that show an
// agent's writing outside mail: an ITSA's body and stam's own view of an agent's
// conversation, so whatever an agent can put in mail works there too. Decisions in it are
// shown, not answered.
import { useLayoutEffect, useMemo, useRef, type MouseEvent } from 'react'
import { api } from '../api'
import { selectThread } from '../actions'
import { useData } from '../store'
import { useFileBase } from '../files/fileBase'
import { fileLinkClick, linkFilePaths, type FileBase } from '../files/pathLinks'
import { useDiffRepos } from '../diff/diffRepos'
import { wireDiffOpen } from './diffOpen'
import { linkPrUrls } from './prLinks'
import { askFocus } from './mailFocus'
import * as mb from './mailblocks'

// `base` says where a relative file path resolves (the writer's machine and cwd); it defaults to the enclosing FileBaseCtx provider, and `null` means none (the writer is unknown).
// `resolve` finishes what needs the mail itself (its embedded and compared attachments) before the rest, when the html changes.
// `shown` is a mail's recorded snapshot range (S-2998), drawn above the rest.
export function Rendered({ text, className = '', base, resolve, shown }: { text: string; className?: string; base?: FileBase | null; resolve?: (el: HTMLElement) => void; shown?: mb.Shown | null }) {
  const ref = useRef<HTMLDivElement>(null)
  // The ITSA list is a dependency, so an S-N key's status updates when its ITSA changes.
  const { itsas } = useData()
  const html = useMemo(() => mb.renderMail(text, shown), [text, itsas, shown?.at, shown?.len])
  const fb = useFileBase(base)
  const repos = useDiffRepos()
  const res = useRef(resolve)
  res.current = resolve
  useLayoutEffect(() => {
    const el = ref.current!
    res.current?.(el)
    mb.renderDiagrams(el)
    mb.highlight(el)
    mb.renderMath(el)
    mb.renderCharts(el)
    mb.resolveThreadLinks(el, (id) => api<mb.ThreadRef[]>('GET', `/api/mail/${id}/thread`).then((r) => r[0] ?? null))
    mb.markDecisions(el, { created_at: '' }, [], false)
    for (const s of el.querySelectorAll('.mb-status')) s.textContent = ''
    linkFilePaths(el, fb)
    wireDiffOpen(el, fb, repos)
  }, [html, fb.host, fb.cwd])
  // Its own effect: the served repos arrive after the first paint, and finishing a mail again for them would redraw its diagrams.
  useLayoutEffect(() => { linkPrUrls(ref.current!, repos); wireDiffOpen(ref.current!, fb, repos) }, [html, repos, fb.host, fb.cwd])
  // A mail link opens its thread at the mail it names (S-415), as in a thread's own mails.
  const click = (e: MouseEvent) => {
    // A fold or control in a diff block never reaches the card around it (S-2100).
    if ((e.target as Element).closest('.mb-diff')) e.stopPropagation()
    if (fileLinkClick(e)) return
    const tl = (e.target as Element).closest<HTMLElement>('[data-thread-link]')
    if (!tl) return
    e.preventDefault()
    if (!tl.dataset.tid) return
    askFocus(tl.dataset.threadLink!, tl.dataset.tid)
    selectThread(tl.dataset.tid)
  }
  return <div className={('md ' + className).trim()} ref={ref} onClick={click} dangerouslySetInnerHTML={{ __html: html }} />
}
