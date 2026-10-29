import { beforeEach, describe, expect, it, vi } from 'vitest'

// The settings file as the daemon has it: GET reads it, PATCH merges a view record per id.
const api = vi.hoisted(() => vi.fn())
const sendAsHuman = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ api, sendAsHuman }))

let settings: Record<string, unknown> = {}
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  localStorage.clear()
  settings = {}
  api.mockReset()
  sendAsHuman.mockReset()
  api.mockImplementation((method: string, path: string, body?: { patch: Record<string, Record<string, unknown>>; fill?: boolean }) => {
    if (method === 'GET' && path === '/api/config/settings') return Promise.resolve({ text: JSON.stringify(settings) })
    if (method === 'PATCH' && path === '/api/config/settings') {
      for (const [k, v] of Object.entries(body!.patch)) {
        const cur = (settings[k] ?? {}) as Record<string, unknown>
        const next = { ...cur }
        for (const [id, x] of Object.entries(v)) {
          if (body!.fill && id in cur) continue
          if (x === null) delete next[id]; else next[id] = x
        }
        settings[k] = next
      }
      return Promise.resolve({ text: JSON.stringify(settings) })
    }
    return Promise.reject(new Error(`unexpected ${method} ${path}`))
  })
})

const load = () => import('./card-layout')

describe('defaults', () => {
  it('are today\'s cards: the board card and the agent card', async () => {
    const m = await load()
    expect(m.defaultCardLayout('issue')).toEqual({
      slots: { TOP: ['parent', 'kind', 'health'], META: ['status', 'rollup', 'links', 'owner'], BADGES: [], FOOT: [] },
      titleLines: 3,
      seen: [],
    })
    expect(m.defaultCardLayout('agent')).toEqual({
      slots: { HEAD: ['model', 'cost'], ISSUE: ['issue'], BADGES: ['health', 'review', 'tests'], FOOT: ['activity'] },
      hairline: true,
      seen: [],
    })
  })

  it('come back as a copy, so a caller changing one leaves the defaults alone', async () => {
    const m = await load()
    m.defaultCardLayout('issue').slots.TOP.push('x')
    expect(m.defaultCardLayout('issue').slots.TOP).toEqual(['parent', 'kind', 'health'])
  })
})

describe('cleanCardLayout', () => {
  it('takes the defaults for anything it cannot read, without throwing', async () => {
    const m = await load()
    for (const bad of [null, 'nope', 5, [], { slots: 'x' }, {}]) {
      expect(m.cleanCardLayout(bad, 'issue')).toEqual(m.defaultCardLayout('issue'))
      expect(m.cleanCardLayout(bad, 'agent')).toEqual(m.defaultCardLayout('agent'))
    }
  })

  it('keeps a layout that follows the rules as it is', async () => {
    const m = await load()
    const l = { slots: { TOP: ['kind'], META: ['status'], BADGES: ['field:f1', 'health'], FOOT: [] }, titleLines: 2, seen: ['field:f1'] }
    expect(m.cleanCardLayout(l, 'issue')).toEqual(l)
  })

  it('drops the locked items: the issue key and title, the agent mark and name', async () => {
    const m = await load()
    const out = m.cleanCardLayout({ slots: { TOP: ['key', 'kind'], META: ['title'], BADGES: [], FOOT: [] }, seen: [] }, 'issue')
    expect(out.slots.TOP).toEqual(['kind'])
    expect(out.slots.META).toEqual([])
    const agent = m.cleanCardLayout({ slots: { HEAD: ['mark', 'name', 'cost'], ISSUE: [], BADGES: [], FOOT: [] }, seen: [] }, 'agent')
    expect(agent.slots.HEAD).toEqual(['cost'])
  })

  it('drops the needs-you mark from every slot: the card always draws it in TOP, so it cannot be placed', async () => {
    const m = await load()
    const out = m.cleanCardLayout({ slots: { TOP: ['needs', 'kind'], META: ['needs'], BADGES: ['needs', 'status'], FOOT: [] }, seen: [] }, 'issue')
    expect(out.slots.TOP).toEqual(['kind'])
    expect(out.slots.META).toEqual([])
    expect(out.slots.BADGES).toEqual(['status'])
  })

  it('seeds the issue layout before the record loads, so a meta field is in META as the migration puts it', async () => {
    const m = await load()
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const fields: Parameters<typeof m.useCardLayout>[1] = [{ id: 'stage', card: 'chip', position: 0 }, { id: 'area', card: 'meta', position: 1 }]
    let got = m.defaultCardLayout('issue')
    function Probe() { got = m.useCardLayout('issue', fields); return null }
    renderToStaticMarkup(createElement(Probe))
    expect(got.slots.META).toEqual(['status', 'rollup', 'links', 'owner', 'field:area'])
    expect(got.slots.BADGES).toEqual(['field:stage'])
  })

  it('clips TOP to 3, META to 5 and FOOT to 3, but not BADGES', async () => {
    const m = await load()
    const ids = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`)
    const out = m.cleanCardLayout({ slots: { TOP: ids(5, 't'), META: ids(7, 'm'), BADGES: ids(9, 'b'), FOOT: ids(4, 'f') }, seen: [] }, 'issue')
    expect(out.slots.TOP).toHaveLength(3)
    expect(out.slots.META).toHaveLength(5)
    expect(out.slots.FOOT).toHaveLength(3)
    expect(out.slots.BADGES).toHaveLength(9)
  })

  it('keeps an item once, in the first slot it appears in', async () => {
    const m = await load()
    const out = m.cleanCardLayout({ slots: { TOP: ['kind', 'kind'], META: ['kind', 'status'], BADGES: ['status'], FOOT: [] }, seen: [] }, 'issue')
    expect(out.slots).toMatchObject({ TOP: ['kind'], META: ['status'], BADGES: [] })
  })

  it('drops items that are not strings, and empty ones', async () => {
    const m = await load()
    const out = m.cleanCardLayout({ slots: { TOP: [1, '', null, 'kind'], META: [], BADGES: [], FOOT: [] }, seen: [] }, 'issue')
    expect(out.slots.TOP).toEqual(['kind'])
  })

  it('takes a title line count of 1, 2 or 3, else 3', async () => {
    const m = await load()
    const at = (titleLines: unknown) => m.cleanCardLayout({ slots: {}, titleLines, seen: [] }, 'issue').titleLines
    expect(at(1)).toBe(1)
    expect(at(2)).toBe(2)
    expect(at(9)).toBe(3)
    expect(at('2')).toBe(3)
  })

  it('reads a layout with slots missing as empty slots, not defaults', async () => {
    const m = await load()
    expect(m.cleanCardLayout({ slots: { TOP: ['kind'] }, seen: [] }, 'issue').slots).toEqual({ TOP: ['kind'], META: [], BADGES: [], FOOT: [] })
  })
})

describe('the seen rule', () => {
  it('lands a new field in BADGES once, and leaves a hidden one hidden', async () => {
    const m = await load()
    const layout = m.defaultCardLayout('issue')
    const once = m.settleIssueFields(layout, ['field:new'])
    expect(once.slots.BADGES).toEqual(['field:new'])
    expect(once.seen).toEqual(['field:new'])
    // The human moves it out of BADGES, then the page reads again: it stays where they put it.
    const hidden = { ...once, slots: { ...once.slots, BADGES: [] } }
    expect(m.settleIssueFields(hidden, ['field:new']).slots.BADGES).toEqual([])
  })

  it('changes nothing when every field has been offered', async () => {
    const m = await load()
    const layout = { ...m.defaultCardLayout('issue'), seen: ['field:a'] }
    expect(m.settleIssueFields(layout, ['field:a'])).toBe(layout)
  })

  it('never shows a field twice: an unseen field already in a slot is marked seen, not added to BADGES', async () => {
    const m = await load()
    const layout = { ...m.defaultCardLayout('issue'), slots: { TOP: [], META: ['field:m'], BADGES: [], FOOT: [] } }
    const out = m.settleIssueFields(layout, ['field:m'])
    expect(out.slots.BADGES).toEqual([])
    expect(out.slots.META).toEqual(['field:m'])
    expect(out.seen).toEqual(['field:m'])
  })
})

describe('seedAgentLayout', () => {
  it('keeps the word badges and adds each chip field after them, in the Work columns\' order', async () => {
    const m = await load()
    const seeded = m.seedAgentLayout([
      { id: 'b', card: 'chip', position: 2 },
      { id: 'a', card: 'meta', position: 1 },
      { id: 'c', card: 'chip', position: 3 },
    ], ['field:c', 'field:b'])
    expect(seeded.slots.BADGES).toEqual(['health', 'review', 'tests', 'field:c', 'field:b'])
    expect(seeded.slots.HEAD).toEqual(['model', 'cost'])
  })

  it('marks every field seen, so a chip the human moved out of BADGES is not added again', async () => {
    const m = await load()
    const seeded = m.seedAgentLayout([{ id: 'c', card: 'chip', position: 1 }])
    expect(seeded.seen).toEqual(['field:c'])
  })
})

describe('settleAgentFields', () => {
  it('adds each new field to BADGES once, as the issue layout does, whatever its card setting', async () => {
    const m = await load()
    const layout = m.seedAgentLayout([])
    const settled = m.settleAgentFields(layout, [{ id: 'n' }, { id: 'o' }])
    expect(settled.slots.BADGES).toEqual(['health', 'review', 'tests', 'field:n', 'field:o'])
    expect(settled.seen).toEqual(['field:n', 'field:o'])
    expect(m.settleAgentFields(settled, [{ id: 'n' }, { id: 'o' }])).toBe(settled)
  })
})

describe('seedIssueLayout', () => {
  it('moves each chip field into BADGES and each meta field into META, in position order', async () => {
    const m = await load()
    const seeded = m.seedIssueLayout([
      { id: 'b', card: 'chip', position: 2 },
      { id: 'a', card: 'chip', position: 1 },
      { id: 'c', card: 'meta', position: 3 },
    ])
    expect(seeded.slots.BADGES).toEqual(['field:a', 'field:b'])
    expect(seeded.slots.META).toEqual(['status', 'rollup', 'links', 'owner', 'field:c'])
    expect(seeded.seen).toEqual(['field:a', 'field:b', 'field:c'])
  })

  it('drops no field: meta past the META cap goes to BADGES', async () => {
    const m = await load()
    const many = Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, card: 'meta' as const, position: i }))
    const seeded = m.seedIssueLayout(many)
    expect(seeded.slots.META).toHaveLength(5)
    expect(seeded.slots.META).toContain('field:m0')
    const placed = [...seeded.slots.META, ...seeded.slots.BADGES].filter((i) => i.startsWith('field:'))
    expect(placed.sort()).toEqual(['field:m0', 'field:m1', 'field:m2', 'field:m3'])
    expect(seeded.seen).toEqual(['field:m0', 'field:m1', 'field:m2', 'field:m3'])
  })

  it('orders chip fields by the Work columns order, not by position', async () => {
    const m = await load()
    const seeded = m.seedIssueLayout(
      [{ id: 'a', card: 'chip', position: 1 }, { id: 'b', card: 'chip', position: 2 }],
      ['field:b', 'field:a'],
    )
    expect(seeded.slots.BADGES).toEqual(['field:b', 'field:a'])
  })
})

describe('the record in settings', () => {
  it('reads what the record holds, per id, and a bad one falls back to the default', async () => {
    settings = { cardLayouts: { issue: { slots: { TOP: ['kind'], META: [], BADGES: [], FOOT: [] }, seen: [] }, agent: 'broken' } }
    const m = await load()
    const rec = await m.loadCardLayouts()
    expect(rec.issue?.slots.TOP).toEqual(['kind'])
    expect(rec.agent).toEqual(m.defaultCardLayout('agent'))
  })

  it('a seed never overwrites an issue layout another page saved after this one loaded', async () => {
    const m = await load()
    await m.loadCardLayouts()
    // Another device writes its issue layout after this page has read the record.
    settings = { cardLayouts: { issue: { slots: { TOP: ['status'], META: [], BADGES: [], FOOT: [] }, seen: [] } } }
    await m.migrateCardLayouts([{ id: 'f1', card: 'chip', position: 1 }])
    await vi.runAllTimersAsync()
    expect((settings.cardLayouts as Record<string, { slots: Record<string, string[]> }>).issue.slots.TOP).toEqual(['status'])
    expect((await m.loadCardLayouts()).issue?.slots.TOP).toEqual(['status'])
  })

  it('migrates once: with no issue layout, seeds it from the fields; a stored layout is not touched', async () => {
    const m = await load()
    await m.migrateCardLayouts([{ id: 'f1', card: 'chip', position: 1 }])
    await vi.runAllTimersAsync()
    expect((settings.cardLayouts as Record<string, { slots: Record<string, string[]> }>).issue.slots.BADGES).toEqual(['field:f1'])
    expect((settings.cardLayouts as Record<string, unknown>).agent).toBeDefined()

    // A second load (a new page, same settings) finds the record and writes nothing more.
    api.mockClear()
    vi.resetModules()
    const again = await load()
    await again.migrateCardLayouts([{ id: 'f2', card: 'chip', position: 1 }])
    await vi.runAllTimersAsync()
    expect(api.mock.calls.filter(([method]) => method === 'PATCH')).toHaveLength(0)
    expect((settings.cardLayouts as Record<string, { slots: Record<string, string[]> }>).issue.slots.BADGES).toEqual(['field:f1'])
  })
})

describe('an agent record main wrote before the system view read it', () => {
  it('is replaced by the seed on the first load, so the system card keeps its badges', async () => {
    settings = { cardLayouts: { agent: { slots: { HEAD: ['model', 'cost'], ISSUE: ['issue'], BADGES: [], FOOT: ['activity'] }, hairline: true, seen: [] } } }
    const m = await load()
    await m.migrateCardLayouts([{ id: 'f1', card: 'chip', position: 1 }])
    await vi.runAllTimersAsync()
    expect((settings.cardLayouts as Record<string, { slots: Record<string, string[]>; seen: string[] }>).agent.slots.BADGES).toEqual(['health', 'review', 'tests', 'field:f1'])
  })

  it('is kept when the human chose its badges: a layout that has seen fields is not the old empty default', async () => {
    settings = { cardLayouts: { agent: { slots: { HEAD: [], ISSUE: ['issue'], BADGES: [], FOOT: [] }, hairline: true, seen: ['field:f1'] } } }
    const m = await load()
    await m.migrateCardLayouts([{ id: 'f1', card: 'chip', position: 1 }])
    await vi.runAllTimersAsync()
    expect((settings.cardLayouts as Record<string, { slots: Record<string, string[]> }>).agent.slots.BADGES).toEqual([])
  })
})
