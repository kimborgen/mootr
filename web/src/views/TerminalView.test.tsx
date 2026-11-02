// @vitest-environment jsdom
// S-4751: a terminal view is attached only while on screen. Its element leaving the main world
// (a background tab, another world) hides the session, which closes its tmux attach, and coming
// back shows it again.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

const calls: string[] = []
vi.mock('../term/TermSession', () => ({
  TermSession: class {
    el = document.createElement('div')
    show() { calls.push('show') }
    hide() { calls.push('hide') }
    sync() {}
    destroy() { calls.push('destroy') }
  },
}))
vi.stubGlobal('requestAnimationFrame', () => 0)
vi.stubGlobal('cancelAnimationFrame', () => {})
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shell = await import('../shell/layout')
const { TerminalView } = await import('./TerminalView')

describe('a terminal view off screen', () => {
  it('hides when its element leaves the main world and shows when it comes back', async () => {
    const main = document.createElement('section')
    main.id = 'w-main'
    document.body.append(main)
    const el = shell.viewElement('agent:a1')
    main.append(el)
    const root = createRoot(el)
    await act(async () => { root.render(<TerminalView viewKey="agent:a1" id="a1" />) })
    expect(calls.at(-1)).toBe('show')

    // A pane parks it (another tab took the pane): the store holds it, out of #w-main.
    await act(async () => { shell.viewStore().append(el); shell.shownChanged() })
    expect(calls.at(-1)).toBe('hide')

    await act(async () => { main.append(el); shell.shownChanged() })
    expect(calls.at(-1)).toBe('show')

    // A hidden tab in a pane that is on screen counts as off screen too.
    await act(async () => { el.hidden = true; shell.shownChanged() })
    expect(calls.at(-1)).toBe('hide')
    await act(async () => { el.hidden = false; shell.shownChanged() })
    expect(calls.at(-1)).toBe('show')

    await act(async () => { root.unmount() })
  })
})
