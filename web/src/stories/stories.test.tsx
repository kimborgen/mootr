// @vitest-environment jsdom
// S-647: every story follows the format (docs/stories.md), names code that still exists, and
// draws each of its states from the fixtures alone, with no request reaching a daemon.
import { act, isValidElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '../api'
import { closeImage, ImageViewer } from '../ImageViewer'
import { closeSpawnPanel } from '../spawn'
import { getData } from '../store'
import { hideMenu, MenuLayer } from '../ui/menu'
import { AGENTS, applyState, installFixtures } from './fixtures'
import { OnMount, pendingStepError } from './helpers'
import isolateSource from '../../public/stories-isolate.js?raw'
import { STORIES } from './registry'
import { GROUPS, reply } from './types'
import { inline } from './Viewer'

// The source of every file in web/src, by path from here, to check the code each story names.
const SOURCES = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true })
// jsdom has no matchMedia, ResizeObserver or visualViewport; the Composer, the add panel, the phone checks and the mail charts ask for them.
beforeAll(() => {
  installFixtures()
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia
  vi.stubGlobal('visualViewport', { addEventListener() {}, removeEventListener() {} })
})

describe('the story format', () => {
  it('finds the primitives stories, each with a unique id in a known group', () => {
    expect(STORIES.length).toBeGreaterThanOrEqual(8)
    expect(new Set(STORIES.map((s) => s.id)).size).toBe(STORIES.length)
    for (const s of STORIES) expect(GROUPS, s.name).toContain(s.group)
    expect(STORIES.filter((s) => s.group === 'Primitives').map((s) => s.name)).toEqual(expect.arrayContaining(['Agent mark', 'Icon', 'Loading', 'Agent states legend', 'Context menu', 'Notice bar', 'Wait mark', 'Image viewer']))
  })

  it('documents each story: what, when, code, rules, and states', () => {
    for (const s of STORIES) {
      expect(s.what.length, s.name).toBeGreaterThan(40)
      expect(s.when.length, s.name).toBeGreaterThan(20)
      expect(s.code.length, s.name).toBeGreaterThan(0)
      expect(s.rules.length, s.name).toBeGreaterThan(0)
      expect(s.states.length, s.name).toBeGreaterThan(0)
      expect(new Set(s.states.map((x) => x.name)).size, s.name).toBe(s.states.length)
    }
  })

  it('names code as path#Symbol, and the symbol is still defined there', () => {
    for (const s of STORIES) for (const ref of s.code) {
      const m = ref.match(/^(web\/src\/[\w./-]+\.tsx?)#(\w+)$/)
      expect(m, `${s.name}: ${ref}`).not.toBeNull()
      const src = SOURCES[m![1].replace(/^web\/src\//, '../')]
      expect(src, `${s.name}: ${ref}`).toBeTypeOf('string')
      expect(src, `${s.name}: ${ref}`).toMatch(new RegExp(`\\b(function|const|let|class|interface|type)\\s+${m![2]}\\b`))
    }
  })
})

describe('the fixtures', () => {
  it('answer api() from the stub, and record the call', async () => {
    expect(await api('GET', '/api/agents')).toEqual(AGENTS)
    await expect(api('GET', '/api/no-such-route')).rejects.toBeInstanceOf(ApiError)
    expect(window.stamStories!.apiCalls).toEqual(expect.arrayContaining(['GET /api/agents', 'GET /api/no-such-route']))
  })

  it('cover each harness with invented names', () => {
    expect(new Set(AGENTS.map((a) => a.harness))).toEqual(new Set(['claude', 'codex', 'opencode']))
    for (const a of AGENTS) expect(a.name).toMatch(/^fixture-/)
  })

  it("apply a state's own data and routes, and reset them for the next state", async () => {
    applyState({ data: { machine: 'fixture-other' }, routes: { 'GET /api/health': reply(503, { error: 'fixture: down' }) } })
    expect(getData().machine).toBe('fixture-other')
    await expect(api('GET', '/api/health')).rejects.toMatchObject({ status: 503, message: 'fixture: down' })
    applyState()
    expect(getData().machine).toBe('fixture-machine')
    expect(await api('GET', '/api/health')).toEqual({ machine: 'fixture-machine' })
  })
})

describe('every state', () => {
  // The menu, the notice bar, and the image viewer draw here, as the frame draws them beside the state.
  const overlays = document.createElement('div')
  beforeAll(() => {
    document.body.appendChild(overlays)
    act(() => { createRoot(overlays).render(<><MenuLayer /><ImageViewer /></>) })
  })
  for (const s of STORIES) for (const st of s.states) it(`${s.name}: ${st.name} draws`, async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    // A failing step still unmounts, so its pending step doesn't fail the states after it.
    try {
      const before = overlays.innerHTML
      // The shell and the UI keep state in storage, which /stories keeps in memory; jsdom's is shared.
      try { localStorage.clear() } catch {}
      applyState(st)
      await act(async () => { root.render(st.render()) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // The state itself drew something; one that renders nothing fails.
      expect(host.childElementCount, 'the state drew nothing').toBeGreaterThan(0)
      // A state with a fixed height is an overlay's: the overlay it opens must have drawn. One that
      // names `overlay` must show that selector, in the state's own host or in the menu layer.
      // The add panel and the model list are drawn in the state itself, fixed to the page.
      // It waits for it (state, not a delay): the overlay opens after the state's fetch resolves.
      if (st.height) {
        await act(async () => {
          await vi.waitFor(() => {
            if (st.overlay) expect(host.querySelector(st.overlay) ?? overlays.querySelector(st.overlay), `the overlay ${st.overlay} drew nothing`).not.toBeNull()
            else expect(overlays.innerHTML !== before || !!host.querySelector('.spawn-panel, .model-list'), 'the overlay drew nothing').toBe(true)
          }, { timeout: 2000 })
        })
      }
      // A step that never succeeds fails the state with its last error, not silently at unmount.
      await act(async () => { await vi.waitFor(() => { const p = pendingStepError(); if (p) throw p.err }, { timeout: 2000 }) })
    } finally {
      act(() => { hideMenu(); closeImage(); closeSpawnPanel(); root.unmount() })
      host.remove()
    }
  })
})

describe('OnMount', () => {
  const mount = async (run: (el: HTMLElement) => void) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<OnMount run={run} />) })
    return () => { act(() => root.unmount()); host.remove() }
  }
  it('stops retrying a step that changes the element and then throws', async () => {
    let calls = 0
    const unmount = await mount((el) => { calls++; el.appendChild(document.createElement('i')); throw new Error('never ready') })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(calls).toBeLessThan(5)
    expect((pendingStepError()?.err as Error).message).toBe('never ready')
    unmount()
    expect(pendingStepError()).toBeUndefined()
  })
  it('runs a step again once what it needs is drawn', async () => {
    let done = false
    let target: HTMLElement | undefined
    const unmount = await mount((el) => { target = el; if (!el.querySelector('b')) throw new Error('no b'); done = true })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(done).toBe(false)
    await act(async () => { target!.appendChild(document.createElement('b')); await new Promise((r) => setTimeout(r, 20)) })
    expect(done).toBe(true)
    expect(pendingStepError()).toBeUndefined()
    unmount()
  })
})

describe('rule text', () => {
  it('renders `code` and [links](url), and leaves the rest as text', () => {
    const parts = inline('Use `--space-3`; see [Motion](https://example.com/#motion).')
    const els = parts.filter(isValidElement) as { type: unknown; props: Record<string, unknown> }[]
    expect(els.some((e) => e.type === 'code' && e.props.children === '--space-3')).toBe(true)
    expect(els.some((e) => e.type === 'a' && e.props.href === 'https://example.com/#motion' && e.props.children === 'Motion')).toBe(true)
  })
})

describe('storage isolation', () => {
  it("swaps the app's IndexedDB, localStorage and sessionStorage for in-memory ones", () => {
    const real = { indexedDB: { real: true }, localStorage: { real: true }, sessionStorage: { real: true } }
    const fake = {} as Record<string, unknown>
    for (const [k, v] of Object.entries(real)) Object.defineProperty(fake, k, { configurable: true, value: v })
    new Function('window', isolateSource)(fake)
    expect(fake.indexedDB).toBeUndefined()
    for (const k of ['localStorage', 'sessionStorage'] as const) {
      const s = fake[k] as Storage
      expect(s).not.toBe(real[k])
      s.setItem('story-key', '1')
      expect(s.getItem('story-key')).toBe('1')
      expect(s.length).toBe(1)
      s.removeItem('story-key')
      expect(s.getItem('story-key')).toBeNull()
    }
  })
  it('loads before the module script on the stories page', async () => {
    const html = (await import('../../stories.html?raw')).default
    expect(html.indexOf('stories-isolate.js')).toBeGreaterThan(-1)
    expect(html.indexOf('stories-isolate.js')).toBeLessThan(html.indexOf('type="module"'))
  })
  // S-763: Vite prefixes base (/web/) to a root-absolute script src, so /web/stories-isolate.js
  // became /web/web/stories-isolate.js, which the daemon answers with the page, not the script.
  // The tag is absolute (the daemon serves the build at /stories, assets under /web/) and
  // vite-ignore, so Vite leaves it alone in dev and build alike.
  it('points at the isolation script the daemon serves, unrewritten by Vite', async () => {
    const html = (await import('../../stories.html?raw')).default
    const tag = html.match(/<script[^>]*stories-isolate\.js[^>]*>/)?.[0] ?? ''
    expect(tag).toContain('src="/web/stories-isolate.js"')
    expect(tag).toContain('vite-ignore')
  })
})
