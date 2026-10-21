// The node sheet names a node's boundary events on a line of their own (S-2249): the marker
// passes taps through, so the events must read as text, and the line must not be clipped.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { DEV_CHANGE } from './fixture'
import { Sheet } from './ProcessView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mount = (nid: string) => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => {
    root.render(<Sheet nid={nid} self={DEV_CHANGE} node={DEV_CHANGE.nodes[nid]} narrow={false} onClose={() => {}} />)
  })
  return { host, done: () => { act(() => root.unmount()); host.remove() } }
}

describe('process sheet', () => {
  it('names a boundary event on its own line', () => {
    const { host, done } = mount('code')
    const lines = [...host.querySelectorAll('.proc-sub')].map((el) => el.textContent)
    expect(lines).toContain('on cost → pause')
    expect(host.querySelector('.proc-bounds')?.textContent).toBe('on cost → pause')
    done()
  })

  it('has no boundary line for a node without boundary events', () => {
    const { host, done } = mount('request')
    expect([...host.querySelectorAll('.proc-sub')].some((el) => /^on /.test(el.textContent ?? ''))).toBe(false)
    done()
  })
})
