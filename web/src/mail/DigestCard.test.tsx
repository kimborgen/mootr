// @vitest-environment jsdom
// The Away digest card (S-2822, S-20): its sections, collapse and dismiss, and the digest hook's rules: a failed or
// missing digest hides it, a dismissed window stays hidden, and presence is sent at most once a minute while visible.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, type ReactElement } from 'react'
import { DigestCard } from './DigestCard'
import { useDigest, type Digest } from './digest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const apiMock = vi.fn(async (..._a: unknown[]): Promise<unknown> => null)
vi.mock('../api', () => ({ api: (...a: unknown[]) => apiMock(...a) }))

const now = Date.now()
const ago = (h: number) => new Date(now - h * 36e5).toISOString()
const digest = (over: Partial<Digest> = {}): Digest => ({
  window: { since: ago(9), until: ago(0) },
  dismissedAt: null,
  happened: {
    merged: [{ pr: 912, title: 'Digest card', itsa: 'S-2822', at: ago(2) }],
    closed: [],
    spawned: [],
    archived: [],
    spend: { usd: 1.4 },
  },
  needs: [{ kind: 'decision', ref: 'S-2801', title: 'Token lifetime', since: ago(5), new: true }],
  next: { itsas: [{ key: 'S-2822', title: 'Away digest card', status: 'in_progress' }], working: [] },
  ...over,
})

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  apiMock.mockClear()
  localStorage.clear()
  vi.useRealTimers()
})

function mount(el: ReactElement) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(el))
  return host
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

describe('DigestCard', () => {
  it('shows the three sections, the Needs summary and the spend', () => {
    const onNeeds = vi.fn()
    const el = mount(<DigestCard digest={digest()} onDismiss={() => {}} onNeeds={onNeeds} onItsa={() => {}} agentId={(n) => n} onAgent={() => {}} />)
    expect(el.querySelector('[data-digest-section="happened"]')?.textContent).toContain('Digest card')
    expect(el.querySelector('[data-digest-section="needs"]')?.textContent).toContain('1 thing needs you · 1 new')
    expect(el.querySelector('[data-digest-spend]')?.textContent).toBe('$1.40 spent')
    expect(el.querySelector('[data-digest-section="next"]')?.textContent).toContain('S-2822')
    act(() => el.querySelector<HTMLButtonElement>('[data-digest-needs]')!.click())
    expect(onNeeds).toHaveBeenCalledTimes(1)
  })

  it('collapses to one line and expands again', () => {
    const el = mount(<DigestCard digest={digest()} onDismiss={() => {}} onNeeds={() => {}} onItsa={() => {}} agentId={(n) => n} onAgent={() => {}} />)
    act(() => el.querySelector<HTMLButtonElement>('[data-digest-toggle]')!.click())
    expect(el.querySelector('[data-digest-section]')).toBeNull()
    expect(el.querySelector('[data-digest-summary]')?.textContent).toBe('1 merged · 1 needs you, 1 new')
    act(() => el.querySelector<HTMLButtonElement>('[data-digest-toggle]')!.click())
    expect(el.querySelector('[data-digest-section="needs"]')).not.toBeNull()
  })

  it('counts what the server holds past what it sent, and links only agents that resolve', () => {
    const d = digest({
      happened: { merged: [], closed: [], spawned: [{ agent: 'fixture-dev', at: ago(1) }, { agent: 'ghost', at: ago(2) }], archived: [], spend: { usd: 0 }, more: { merged: 2 } },
      needsMore: 4,
    })
    const el = mount(<DigestCard digest={d} onDismiss={() => {}} onNeeds={() => {}} onItsa={() => {}} agentId={(n) => (n === 'fixture-dev' ? 'a1' : undefined)} onAgent={() => {}} />)
    expect(el.querySelector('[data-digest-section="happened"]')?.textContent).toContain('+2 more')
    expect(el.querySelector('[data-digest-section="needs"]')?.textContent).toContain('5 things need you')
    const links = [...el.querySelectorAll('[data-digest-section="happened"] button')].map((b) => b.textContent)
    expect(links).toEqual(['fixture-dev'])
    expect(el.textContent).toContain('ghost')
  })

  it('dismisses through its button', () => {
    const onDismiss = vi.fn()
    const el = mount(<DigestCard digest={digest()} onDismiss={onDismiss} onNeeds={() => {}} onItsa={() => {}} agentId={(n) => n} onAgent={() => {}} />)
    act(() => el.querySelector<HTMLButtonElement>('[data-digest-dismiss]')!.click())
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

// A probe that draws whether the hook shows a digest, so the hook's rules read as the card does.
function Probe() {
  const [d, dismiss] = useDigest()
  return <div data-probe={d ? 'shown' : 'hidden'} onClick={dismiss} />
}

describe('useDigest', () => {
  it('hides the card when the digest fails', async () => {
    apiMock.mockImplementation(async () => { throw new Error('down') })
    const el = mount(<Probe />)
    await flush()
    expect(el.querySelector('[data-probe]')?.getAttribute('data-probe')).toBe('hidden')
  })

  it('hides the card when there is no window, and when the window was dismissed', async () => {
    apiMock.mockImplementation(async (...a: unknown[]) => (a[1] === '/api/digest' ? digest({ window: null }) : null))
    const el = mount(<Probe />)
    await flush()
    expect(el.querySelector('[data-probe]')?.getAttribute('data-probe')).toBe('hidden')
    act(() => root!.unmount())
    root = null
    localStorage.setItem('digest-dismissed', digest().window!.until)
    apiMock.mockImplementation(async (...a: unknown[]) => (a[1] === '/api/digest' ? digest() : null))
    const again = mount(<Probe />)
    await flush()
    expect(again.querySelector('[data-probe]')?.getAttribute('data-probe')).toBe('hidden')
  })

  it('shows a window that is not dismissed, and a dismiss stays hidden through a reload', async () => {
    apiMock.mockImplementation(async (...a: unknown[]) => (a[1] === '/api/digest' ? digest() : null))
    const el = mount(<Probe />)
    await flush()
    expect(el.querySelector('[data-probe]')?.getAttribute('data-probe')).toBe('shown')
    act(() => el.querySelector<HTMLDivElement>('[data-probe]')!.click())
    expect(el.querySelector('[data-probe]')?.getAttribute('data-probe')).toBe('hidden')
    expect(localStorage.getItem('digest-dismissed')).toBe(digest().window!.until)
    expect(apiMock).toHaveBeenCalledWith('POST', '/api/digest/dismiss', { until: digest().window!.until })
  })

  it('reloads the digest when presence returns a new window on coming back', async () => {
    let digests = 0
    apiMock.mockImplementation(async (...a: unknown[]) => {
      if (a[1] === '/api/digest') return digests++ === 0 ? digest({ window: null }) : digest()
      if (a[1] === '/api/presence') return { window: digest().window }
      return null
    })
    const visible = vi.spyOn(Document.prototype, 'visibilityState', 'get').mockReturnValue('visible')
    vi.useFakeTimers()
    const el = mount(<Probe />)
    await flush()
    expect(el.querySelector('[data-probe]')?.getAttribute('data-probe')).toBe('hidden')
    // Coming back is throttled like any presence: a minute on, the return sends it.
    act(() => { vi.advanceTimersByTime(60_000) })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); for (let i = 0; i < 5; i++) await Promise.resolve() })
    expect(el.querySelector('[data-probe]')?.getAttribute('data-probe')).toBe('shown')
    visible.mockRestore()
  })

  it('sends presence at most once a minute while the page is visible', async () => {
    vi.useFakeTimers()
    apiMock.mockImplementation(async (...a: unknown[]) => (a[1] === '/api/presence' ? { window: null } : null))
    mount(<Probe />)
    await flush()
    const presence = () => apiMock.mock.calls.filter((c) => c[1] === '/api/presence').length
    for (let i = 0; i < 3; i++) act(() => { dispatchEvent(new Event('pointerdown')) })
    expect(presence()).toBe(1)
    act(() => { vi.advanceTimersByTime(60_000) })
    act(() => { dispatchEvent(new Event('keydown')) })
    expect(presence()).toBe(2)
  })

  it('sends no presence while the page is hidden', async () => {
    apiMock.mockImplementation(async () => null)
    const hidden = vi.spyOn(Document.prototype, 'visibilityState', 'get').mockReturnValue('hidden')
    mount(<Probe />)
    await flush()
    act(() => { dispatchEvent(new Event('touchstart')) })
    expect(apiMock.mock.calls.some((c) => c[1] === '/api/presence')).toBe(false)
    hidden.mockRestore()
  })
})
