// @vitest-environment jsdom
// S-1527: a click on a line number marks that line and reports it, for the caller to write a #L link.
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeView } from './CodeView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })

async function mount(el: React.ReactElement) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(el))
  await vi.waitFor(() => expect(host.querySelector('.cm-line')).not.toBeNull())
  return host
}

describe('CodeView', () => {
  it('a gutter click moves the mark and calls onLineLink', async () => {
    const onLineLink = vi.fn()
    const host = await mount(<CodeView text={'one\ntwo\nthree\n'} path="a.ts" onLineLink={onLineLink} />)
    expect(host.querySelector('.cm-selectedLine')).toBeNull()
    const num = [...host.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].find(e => e.textContent === '1')!
    act(() => { num.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
    expect(onLineLink).toHaveBeenCalledWith(1)
    expect(host.querySelector('.cm-selectedLine')?.textContent).toBe('one')
  })

  it('the line prop marks that line', async () => {
    const host = await mount(<CodeView text={'one\ntwo\nthree\n'} path="a.ts" line={2} />)
    await vi.waitFor(() => expect(host.querySelector('.cm-selectedLine')?.textContent).toBe('two'))
  })

  it('an empty file says so', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(<CodeView text="" path="a.ts" />))
    expect(host.textContent).toContain('This file is empty.')
  })
})
