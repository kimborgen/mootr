// @vitest-environment jsdom
// The type page (S-887): the tabs, the instructions it reuses from the inventory, the agents list
// with its median figures, and which proposals count as touching a type.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECENT_AGENTS, TypeView, agentsOfType, bytes, proposalTouches, specialistsOf } from './TypeView'
import { small } from './inventory-fixture'
import { getData, setData } from '../store'
import type { Agent } from '../types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ag = (i: number, type: string, lifecycle: Agent['lifecycle']): Agent =>
  ({ id: `a${i}`, name: `agent-${i}`, harness: 'claude', type, lifecycle, activity: 'idle', machine: 'm', cwd: '/', parents: [], created_at: '', updated_at: `2026-10-14T${String(i % 24).padStart(2, '0')}:00:00Z` }) as Agent
const stat = (median: number) => ({ n: 4, median, p75: median })
const answers: Record<string, unknown> = {
  '/api/registry': { harnesses: { claude: {}, codex: {} }, types: { developer: { description: 'Makes one change.', harness: 'claude', model: 'claude-opus-5-5', effort: 'medium' } } },
  '/api/types/developer/inventory': small,
  '/api/retros': { items: [
    { id: 'r1', key: 'S-71', title: 'Tests ran twice', kind: 'improve', target: 'developer-change', plusOnes: 2, status: 'idea', created_at: '' },
    { id: 'r2', key: 'S-72', title: 'Scratch in tmp worked', kind: 'went_well', target: 'none', plusOnes: 0, status: 'done', created_at: '' },
  ], effort: [], coverage: { archived: 0, withRound: 0, without: [] } },
  '/api/blocks/composing': { blocks: [
    { id: 'intro', title: 'Intro', summary: 'Who you are.', tokens: 100, template: 'system-prompt', rendered: true, applies: true },
    { id: 'waiting', title: 'Waiting', summary: 'Wait for mail.', tokens: 200, template: 'system-prompt', rendered: true, applies: true },
  ], replacements: [{ path: 'blocks/_replace/short.md', id: 'short', title: 'Short', summary: 's', tokens: 20 }] },
  '/api/skills': [
    { name: 'tidy', path: '/h/skills/tidy', source: 'stam', description: 'Tidy up scratch files.', tokens: 100, extraTokens: 0, reaches: {}, attachedTo: [], bodySummary: { state: 'off' } },
    { name: 'style', path: '/h/skills/style', source: 'user', description: 'Write short.', tokens: 100, extraTokens: 0, reaches: {}, attachedTo: [], bodySummary: { state: 'off' } },
  ],
  '/api/config/settings': { text: '{}' },
  '/api/activity': { rows: [{ type: 'developer', n: 4, working_s: stat(1500), waiting_s: stat(5400), cost_usd: stat(1.84), review_rounds: stat(1) }] },
}
const calls: string[] = []
const posts: Array<{ path: string; body: any }> = []
let postStatus = 200
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  calls.length = 0
  posts.length = 0
  postStatus = 200
  const many = [...Array.from({ length: 20 }, (_, i) => ag(i, 'developer', 'archived')), ag(30, 'developer', 'active'), ag(31, 'reviewer', 'active')]
  setData({
    ...getData(), agents: many,
    itsas: [
      { id: 'p1', key: 'S-91', kind: 'proposal', title: 'Tweak type-developer', summary: null, body: null, status: 'needs_approval', updated_at: '2026-10-14T00:00:00Z' },
      { id: 'p2', key: 'S-92', kind: 'proposal', title: 'Tweak type-reviewer', summary: null, body: null, status: 'todo', updated_at: '2026-10-14T00:00:00Z' },
    ] as never,
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(url, 'http://x')
    if (init?.method === 'POST') {
      posts.push({ path: u.pathname, body: JSON.parse(init.body ?? '{}') })
      return new Response(JSON.stringify(postStatus === 200 ? {} : { error: 'agents may not change types' }), { status: postStatus, headers: { 'content-type': 'application/json' } })
    }
    calls.push(u.pathname + u.search)
    const body = answers[u.pathname]
    return new Response(JSON.stringify(body ?? { error: 'none' }), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } })
  }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const click = async (label: string) => { await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[role=tab]')].find((b) => b.textContent === label)!.click() }); await flush() }

describe('proposalTouches', () => {
  const p = (o: object) => ({ kind: 'proposal', title: '', summary: null, body: null, ...o })
  it('matches the template name as a whole word, in proposals only', () => {
    expect(proposalTouches(p({ body: 'Edits templates/type-developer.md' }), 'developer')).toBe(true)
    expect(proposalTouches(p({ title: 'type-dev-lead' }), 'dev')).toBe(false)
    expect(proposalTouches(p({ body: 'type-developer' }), 'dev')).toBe(false)
    expect(proposalTouches(p({ kind: 'issue', body: 'type-developer' }), 'developer')).toBe(false)
  })
})

describe('agentsOfType', () => {
  it('lists live agents first and caps the others', () => {
    const list = agentsOfType(getData().agents, 'developer')
    expect(list[0].id).toBe('a30')
    expect(list.length).toBe(1 + RECENT_AGENTS)
    expect(list.every((a) => a.type === 'developer')).toBe(true)
  })
})

describe('TypeView', () => {
  it('shows the header and the type inventory, then the agents with medians, then its proposals', async () => {
    await act(async () => { root.render(<TypeView name="developer" />) })
    await flush()
    expect(host.querySelector('h2')?.textContent).toBe('developer')
    expect(host.textContent).toContain('Makes one change.')
    expect(host.querySelectorAll('.inv-card').length).toBeGreaterThan(0)
    expect(calls).toContain('/api/types/developer/inventory')
    await click('Agents')
    expect(host.querySelectorAll('.type-agent').length).toBe(1 + RECENT_AGENTS)
    expect(host.querySelector('.type-stats')?.textContent).toContain('$1.84')
    expect(host.querySelector('.type-stats')?.textContent).toContain('25m')
    await click('Proposals')
    const rows = [...host.querySelectorAll('.type-agent')]
    expect(rows.map((r) => r.getAttribute('data-itsa'))).toEqual(['S-91'])
  })
  it('lists the type\'s standing specialists with their load and workspace size', async () => {
    const load = { open_itsas: 3, median_lead_s: 5400, lead_n: 10, context_tokens: 250000, context_threshold: 500000, context_ratio: 0.5, workspace_bytes: 2048, workspace_files: 4 }
    setData({ ...getData(), agents: [{ ...ag(40, 'developer', 'active'), standing: 1, load }, { ...ag(41, 'developer', 'archived'), standing: 1 }, ag(42, 'developer', 'active')] as never })
    await act(async () => { root.render(<TypeView name="developer" />) })
    await flush()
    await click('Agents')
    const rows = [...host.querySelectorAll('[data-specialists] .type-specialist')]
    expect(rows.map((r) => r.getAttribute('data-agent'))).toEqual(['a40'])
    expect(rows[0].textContent).toContain('3 open')
    expect(rows[0].textContent).toContain('lead 1.5h of 10')
    expect(rows[0].textContent).toContain('context 50%')
    expect(rows[0].textContent).toContain('workspace 2.0 KB, 4 files')
    expect(specialistsOf(getData().agents, 'developer').length).toBe(1)
    expect(bytes(null)).toBe('–')
    expect(bytes(5000000, true)).toBe('4.8 MB+')
  })
  it('lists the type\'s retro items, open and done, from the type filter', async () => {
    await act(async () => { root.render(<TypeView name="developer" />) })
    await flush()
    await click('Memory')
    expect(calls).toContain('/api/retros?type=developer')
    const rows = [...host.querySelectorAll('[data-type-memory] .retro-row')]
    expect(rows.map((r) => r.getAttribute('data-itsa'))).toEqual(['S-71', 'S-72'])
    expect(rows[0].textContent).toContain('+2')
    expect(rows[0].textContent).toContain('developer-change')
    expect(rows[1].textContent).toMatch(/done/i)
  })
  it('says so for an unknown type', async () => {
    await act(async () => { root.render(<TypeView name="ghost" />) })
    await flush()
    expect(host.textContent).toContain('no agent type named ghost')
  })

  describe('composer', () => {
    const q = (sel: string) => host.querySelector<HTMLElement>(sel)!
    const total = () => q('.comp-total b').textContent
    const press = async (el: HTMLElement) => { await act(async () => { el.click() }); await flush() }
    const open = async () => { await act(async () => { root.render(<TypeView name="developer" />) }); await flush() }
    it('lists the blocks, updates the token total on a switch, and saves off and order through POST /api/types', async () => {
      await open()
      const before = Number(total()!.replace(/,/g, ''))
      expect(host.querySelectorAll('.comp-row').length).toBe(2)
      expect((q('.comp-foot .btn.primary') as HTMLButtonElement).disabled).toBe(true)
      await press(q('[data-block=waiting] input'))
      expect(q('[data-block=waiting] .inv-struck')).toBeTruthy()
      expect(Number(total()!.replace(/,/g, ''))).toBe(before - 200)
      await press(q('[aria-label="Move Intro down"]'))
      expect([...host.querySelectorAll('.comp-row')].map((r) => r.getAttribute('data-block'))).toEqual(['waiting', 'intro'])
      await press(q('.comp-foot .btn.primary'))
      expect(posts).toHaveLength(1)
      expect(posts[0].path).toBe('/api/types/developer')
      expect(posts[0].body).toMatchObject({ harness: 'claude', blocks: { off: ['waiting'], order: ['waiting', 'intro'] } })
    })
    it('saves a replacement, and shows the error when the daemon refuses an agent', async () => {
      await open()
      const sel = q('[data-block=intro] select') as HTMLSelectElement
      await act(async () => { sel.value = 'blocks/_replace/short.md'; sel.dispatchEvent(new Event('change', { bubbles: true })) })
      expect(Number(total()!.replace(/,/g, ''))).toBe(Number(q('.comp-total .muted')!.textContent!.replace(/\D/g, '')) - 80)
      postStatus = 403
      await press(q('.comp-foot .btn.primary'))
      expect(posts[0].body.blocks).toEqual({ replace: { intro: 'blocks/_replace/short.md' } })
      expect(q('.comp-err').textContent).toContain('agents may not change types')
      await press([...host.querySelectorAll<HTMLElement>('.comp-foot .btn')].find((x) => x.textContent === 'Discard')!)
      expect((q('[data-block=intro] select') as HTMLSelectElement).value).toBe('')
    })
    it('is read-only on a peer that has no page of the home', async () => {
      answers['/api/config/settings'] = { text: '{}', home: 'elsewhere' }
      await open()
      expect(host.textContent).toContain('change it on elsewhere')
      expect((q('[data-block=waiting] input') as HTMLInputElement).disabled).toBe(true)
      expect((q('.comp-foot .btn.primary') as HTMLButtonElement).disabled).toBe(true)
      answers['/api/config/settings'] = { text: '{}' }
    })
    it('previews the saved type on each harness, and only when nothing is unsaved', async () => {
      await open()
      const preview = [...host.querySelectorAll<HTMLButtonElement>('.comp-foot .btn')].find((x) => x.textContent === 'Preview as agent')!
      await press(preview)
      expect([...host.querySelectorAll('.comp-preview')].map((d) => d.getAttribute('data-harness'))).toEqual(['claude', 'codex'])
      expect(calls).toContain('/api/types/developer/inventory?harness=codex')
      await press(preview)
      await press(q('[data-block=waiting] input'))
      expect(preview.disabled).toBe(true)
    })
  })

  describe('skills tab', () => {
    const q = (sel: string) => host.querySelector<HTMLElement>(sel)!
    const press = async (el: HTMLElement) => { await act(async () => { el.click() }); await flush() }
    const open = async () => { await act(async () => { root.render(<TypeView name="developer" />) }); await flush(); await click('Skills') }
    it('attaches and detaches skills, shows the block tokens, and saves skills through POST /api/types', async () => {
      await open()
      expect(host.querySelectorAll('.type-skills .comp-row').length).toBe(2)
      expect(q('.comp-total b').textContent).toBe('0')
      expect((q('.comp-foot .btn.primary') as HTMLButtonElement).disabled).toBe(true)
      await press(q('[data-skill=tidy] input'))
      expect(Number(q('.comp-total b').textContent)).toBeGreaterThan(25)
      await press(q('.comp-foot .btn.primary'))
      expect(posts).toHaveLength(1)
      expect(posts[0].path).toBe('/api/types/developer')
      expect(posts[0].body).toMatchObject({ harness: 'claude', skills: ['tidy'] })
    })
    it('shows the error when the daemon refuses an agent, and Discard restores the saved list', async () => {
      await open()
      await press(q('[data-skill=style] input'))
      postStatus = 403
      await press(q('.comp-foot .btn.primary'))
      expect(q('.comp-err').textContent).toContain('agents may not change types')
      await press([...host.querySelectorAll<HTMLElement>('.comp-foot .btn')].find((x) => x.textContent === 'Discard')!)
      expect((q('[data-skill=style] input') as HTMLInputElement).checked).toBe(false)
    })
    it('is read-only on a peer that has no page of the home', async () => {
      answers['/api/config/settings'] = { text: '{}', home: 'elsewhere' }
      await open()
      expect((q('[data-skill=tidy] input') as HTMLInputElement).disabled).toBe(true)
      expect((q('.comp-foot .btn.primary') as HTMLButtonElement).disabled).toBe(true)
      answers['/api/config/settings'] = { text: '{}' }
    })
  })
})
