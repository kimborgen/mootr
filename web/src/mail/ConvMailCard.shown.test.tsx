// @vitest-environment jsdom
// The ITSA view's thread draws an ask through this card: the recorded snapshot range gets its box there too (S-2998).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ConvMailCard, type ConvMail } from './ConvMailCard'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
})
let host: HTMLElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const snap = '<details><summary>What you approve: S-1 Real</summary>\n\nThe real text.\n\n</details>'
const ask = (shown?: ConvMail['shown']): ConvMail => ({ id: 'm1', from_id: 'a1', from_name: 'kid', body: snap + '\n\nOwner says hi', recipients: [{ id: 'human' }], created_at: '2026-10-21T00:00:00.000Z', kind: 'ask', shown })

describe('ConvMailCard snapshot box', () => {
  it('draws the recorded range in its box, and none without one', async () => {
    await act(async () => { root.render(<ConvMailCard m={ask({ at: 0, len: snap.length })} full noThread />) })
    expect(host.querySelector('.mb-shown summary')?.textContent).toBe('What you approve: S-1 Real')
    expect(host.querySelector('.mb-shown')?.textContent).not.toContain('Owner says')
    await act(async () => { root.render(<ConvMailCard m={ask()} full noThread />) })
    expect(host.querySelector('.mb-shown')).toBeNull()
  })
})
