// @vitest-environment jsdom
// A failed model-list load (S-687) is not kept: the next open of the picker asks again, so a
// load that failed once shows the list when the daemon answers the second time.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker } from './ModelPicker'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // jsdom has no matchMedia; the picker asks it whether it is on a phone.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  let calls = 0
  fetchMock = vi.fn(async () => {
    calls++
    if (calls === 1) return { ok: false, status: 502, json: async () => ({ error: 'catalogue unreachable' }) }
    return { ok: true, status: 200, json: async () => ({ models: [{ id: 'fixture/model-a', name: 'Model A', in: 1, out: 2 }] }) }
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const input = () => host.querySelector('input') as HTMLInputElement

describe('ModelPicker after a failed load', () => {
  it('asks again on the next open, and shows the list when the load succeeds', async () => {
    await act(async () => { root.render(<ModelPicker kind="openrouter" value="" label="Model" onChange={() => {}} />) })

    await act(async () => { input().focus() })
    await flush()
    expect(host.textContent).toContain("Couldn't load the models: catalogue unreachable")

    // Leave the field (Escape closes the list), then open it again.
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await act(async () => { input().blur() })
    await act(async () => { input().focus() })
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(host.textContent).not.toContain("Couldn't load the models")
    expect(host.querySelector('[role="option"]')?.textContent).toContain('Model A')
  })

  it('asks again when typing reopens the list after Escape, with focus still in the field', async () => {
    // A harness catalogue, not the OpenRouter one the first case cached for the page.
    await act(async () => { root.render(<ModelPicker kind="harness" harness="codex" value="" label="Model" onChange={() => {}} />) })

    await act(async () => { input().focus() })
    await flush()
    expect(host.textContent).toContain("Couldn't load the models: catalogue unreachable")

    // Escape closes the list but keeps focus in the field; typing reopens it.
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(input(), 'Model')
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(host.textContent).not.toContain("Couldn't load the models")
    expect(host.querySelector('[role="option"]')?.textContent).toContain('Model A')
  })
})
