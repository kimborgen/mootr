// @vitest-environment jsdom
// A fold or control inside a diff block never reaches the card around it (S-2100).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Rendered } from './Rendered'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
})
let host: HTMLElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })

describe('Rendered diff block', () => {
  it('keeps a click on a diff control from activating the card', async () => {
    const card = vi.fn()
    await act(async () => { root.render(<div onClick={card}><Rendered text={'```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+a\n```\n\nplain text'} /></div>) })
    await click(host.querySelector('.mb-diff summary')!)
    await click(host.querySelector('.mb-dscroll')!)
    expect(card).not.toHaveBeenCalled()
    await click(host.querySelector('.md p')!)
    expect(card).toHaveBeenCalledTimes(1)
  })
})
