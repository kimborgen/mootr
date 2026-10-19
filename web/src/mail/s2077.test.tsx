// @vitest-environment jsdom
// S-2084: opening S-2077 crashed the app. Its comment's diff opens with a `+++` header and no
// `---` before it, which threw in the diff component, and nothing caught it short of the root.
// The fixtures are S-2077's body (a 32-key Answers line) and that comment, verbatim.
import { act, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import * as mb from './mailblocks'
import { ViewBoundary } from '../views/ViewBoundary'
import { ViewHost } from '../views/registry'
import { viewElement } from '../shell/layout'
import body from './s2077-body.fixture.md?raw'
import comment from './s2077-diff.fixture.md?raw'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const html = (text: string) => { const d = document.createElement('div'); d.innerHTML = mb.renderMail(text); return d }

describe('S-2077 content', () => {
  it('renders the body with its 32-key Answers line', () => {
    expect(body).toContain('Answers: S-1878')
    expect(html(body).textContent).toContain('S-1908')
  })

  it('folds the diff per file, a `+++` without a `---` opening its own file', () => {
    const d = html(comment)
    const paths = [...d.querySelectorAll('.mb-diff .mb-path')].map((p) => p.textContent)
    expect(paths).toEqual([
      'blocks/type-reviewer/20-reviewer-checks.md   (same text in blocks/type-reviewer-opus/20-reviewer-opus-checks.md)',
      'blocks/type-developer/40-developer-before-report.md',
      'blocks/type-manager/30-manager-mail-wait.md',
      'templates/ring-turn.md   (before "Submit your contribution")',
      'docs/pull-requests.md   (before "On host1, a developer may still run")',
      'docs/testing.md   (before "Reproduce a scale or perf bug")',
    ])
    const counts = [...d.querySelectorAll('.mb-diff .mb-count')].map((c) => c.textContent)
    expect(counts[2]).toBe('+1 −1')
  })

  it('keeps a plain `---`/`+++` pair as one file', () => {
    const d = html('```diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n```')
    expect([...d.querySelectorAll('.mb-path')].map((p) => p.textContent)).toEqual(['x.ts'])
  })
})

describe('ViewBoundary', () => {
  it('shows a failing view as an error in its pane, not a blank app', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Boom = () => { throw new Error('bad block') }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(<div><ViewBoundary viewKey="itsa:i1"><Boom /></ViewBoundary><p id="other">still here</p></div>) })
    expect(host.querySelector('[data-view-error="itsa:i1"]')?.textContent).toContain('bad block')
    expect(host.querySelector('#other')?.textContent).toBe('still here')
    await act(async () => { root.unmount() })
    host.remove()
    err.mockRestore()
  })

  it('keeps the error in its view element when a mounted view throws on a later render', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let fail = false
    let bump = () => {}
    const Flaky = () => {
      const [, set] = useState(0)
      bump = () => set((n) => n + 1)
      if (fail) throw new Error('content arrived bad')
      return <p>fine</p>
    }
    const key = 'itsa:s2084'
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createPortal(<ViewHost viewKey={key}><Flaky /></ViewHost>, viewElement(key), key)) })
    const el = viewElement(key)
    expect(el.textContent).toBe('fine')
    fail = true
    await act(async () => { bump() })
    // The element is the one the pane adopted: still attached, still the registered one, showing the error.
    expect(el.isConnected).toBe(true)
    expect(viewElement(key)).toBe(el)
    expect(el.querySelector(`[data-view-error="${key}"]`)?.textContent).toContain('content arrived bad')
    fail = false
    await act(async () => { el.querySelector<HTMLButtonElement>('button')!.click() })
    expect(el.textContent).toBe('fine')
    await act(async () => { root.unmount() })
    expect(el.isConnected).toBe(false)
    host.remove()
    err.mockRestore()
  })
})
