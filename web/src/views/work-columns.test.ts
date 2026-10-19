import { describe, expect, it, vi } from 'vitest'
// The daemon's settings file, as GET returns it and PATCH merges into it per view id.
const settings = vi.hoisted(() => ({ value: {} as Record<string, Record<string, unknown>> }))
vi.mock('../api', () => ({
  sendAsHuman: vi.fn(),
  api: vi.fn(async (method: string, path: string, body?: { patch: Record<string, Record<string, unknown>> }) => {
    if (path !== '/api/config/settings') return {}
    if (method === 'GET') return { text: JSON.stringify(settings.value) }
    for (const [k, v] of Object.entries(body!.patch)) {
      const next = { ...(settings.value[k] ?? {}) }
      for (const [id, x] of Object.entries(v)) { if (x === null) delete next[id]; else next[id] = x }
      settings.value[k] = next
    }
    return {}
  }),
}))
import { defaultLayout, loadStore, loadWork, moveBy, saveAs, saveStore, setShown } from '../work/views'
import { fieldColId, workColumnIds, type Field } from '../itsa/fields'
import { columnRows, dropOn, fieldOrder, formOf, keyFrom, moveItem, payloadOf, writeLayout } from './work-columns'

// The registry's shape since S-363: `work` is the one locked column, first.
const BUILTIN = ['work', 'status', 'agents', 'cost']
const LABELS = { work: 'Work', status: 'Status', agents: 'Agents', cost: 'Cost' }
const field = (id: string, key: string, position: number, extra: Partial<Field> = {}): Field => ({
  id, key, label: key[0].toUpperCase() + key.slice(1), type: 'text', options: null, description: null, hint: null,
  width: 'm', align: 'start', card: 'meta', position, ...extra,
})
const STAGE = field('f1', 'stage', 0, { type: 'choice', options: [{ value: 'dev', label: 'Dev', tone: 'accent' }] })
const DUE = field('f2', 'due', 1, { type: 'date' })
const FIELDS = [DUE, STAGE]
const IDS = workColumnIds(BUILTIN, FIELDS)

describe('workColumnIds', () => {
  it('puts the fields by position after the built-ins', () => {
    expect(IDS).toEqual(['work', 'status', 'agents', 'cost', 'field:f1', 'field:f2'])
  })
  it('puts them after work alone', () => {
    expect(workColumnIds(['work'], FIELDS)).toEqual(['work', 'field:f1', 'field:f2'])
  })
})

describe('columnRows', () => {
  it('lists every column, hidden ones where they would show, with labels and fields', () => {
    const l = setShown(setShown(defaultLayout(IDS), IDS, 'agents', false), IDS, 'field:f2', false)
    const rows = columnRows(l, IDS, LABELS, FIELDS)
    expect(rows.map((r) => [r.id, r.label, r.shown])).toEqual([
      ['work', 'Work', true], ['status', 'Status', true], ['agents', 'Agents', false], ['cost', 'Cost', true],
      ['field:f1', 'Stage', true], ['field:f2', 'Due', false],
    ])
    expect(rows.find((r) => r.id === 'field:f1')!.field).toBe(STAGE)
    expect(rows.find((r) => r.id === 'cost')!.field).toBeNull()
  })

  it('locks work, and moves only shown columns after it', () => {
    const l = setShown(defaultLayout(IDS), IDS, 'agents', false)
    const by = Object.fromEntries(columnRows(l, IDS, LABELS, FIELDS).map((r) => [r.id, r]))
    expect([by.work.locked, by.work.canUp, by.work.canDown]).toEqual([true, false, false])
    expect([by.status.canUp, by.status.canDown]).toEqual([false, true])
    expect([by['field:f2'].canUp, by['field:f2'].canDown]).toEqual([true, false])
    expect([by.agents.canUp, by.agents.canDown]).toEqual([false, false])
  })
})

describe('dropOn', () => {
  it('drops a column just above a shown row', () => {
    expect(dropOn(defaultLayout(IDS), IDS, 'field:f2', 'status').cols).toEqual(['work', 'field:f2', 'status', 'agents', 'cost', 'field:f1'])
  })
  it('lands just above the row moving down too, and below it on its lower half', () => {
    expect(dropOn(defaultLayout(IDS), IDS, 'status', 'cost').cols).toEqual(['work', 'agents', 'status', 'cost', 'field:f1', 'field:f2'])
    expect(dropOn(defaultLayout(IDS), IDS, 'status', 'agents').cols).toEqual(defaultLayout(IDS).cols)
    expect(dropOn(defaultLayout(IDS), IDS, 'status', 'cost', true).cols).toEqual(['work', 'agents', 'cost', 'status', 'field:f1', 'field:f2'])
  })
  it("reaches the end by the last row's lower half", () => {
    expect(dropOn(defaultLayout(IDS), IDS, 'status', 'field:f2', true).cols).toEqual(['work', 'agents', 'cost', 'field:f1', 'field:f2', 'status'])
  })
  it('lands on a hidden row where that row would show', () => {
    const base = setShown(defaultLayout(IDS), IDS, 'agents', false)
    expect(dropOn(base, IDS, 'field:f1', 'agents').cols).toEqual(['work', 'status', 'field:f1', 'cost', 'field:f2'])
    const hidCost = setShown(defaultLayout(IDS), IDS, 'cost', false)
    expect(dropOn(hidCost, IDS, 'status', 'cost').cols).toEqual(['work', 'agents', 'status', 'field:f1', 'field:f2'])
  })
  it('never moves above work', () => {
    expect(dropOn(defaultLayout(IDS), IDS, 'cost', 'work').cols[0]).toBe('work')
  })
})

describe('fieldOrder', () => {
  it('is null while the fields keep their order', () => {
    expect(fieldOrder(moveBy(defaultLayout(IDS), IDS, 'cost', -1), IDS, FIELDS)).toBeNull()
  })
  it('follows the layout when a custom column passes another', () => {
    expect(fieldOrder(moveBy(defaultLayout(IDS), IDS, 'field:f2', -1), IDS, FIELDS)).toEqual(['f2', 'f1'])
  })
})

describe('keyFrom', () => {
  it('makes a slug starting with a letter, up to 32 characters', () => {
    expect(keyFrom('Due date!')).toBe('due-date')
    expect(keyFrom('2nd reviewer')).toBe('c-2nd-reviewer')
    expect(keyFrom('')).toBe('column')
    expect(keyFrom('x'.repeat(40))).toHaveLength(32)
  })
  it('avoids keys taken', () => {
    expect(keyFrom('Stage', ['stage', 'stage-2'])).toBe('stage-3')
  })
  it('drops a trailing dash before the suffix', () => {
    const long = 'x'.repeat(29) + '-yy'
    expect(keyFrom(long, [long])).toBe('x'.repeat(29) + '-2')
  })
})

describe('payloadOf', () => {
  it('sends a choice field with its options, deriving the key and blank values', () => {
    const f = { ...formOf(), label: ' Stage ', type: 'choice' as const, description: 'Where the work is', hint: ' ',
      options: [{ value: '', label: 'In review', tone: 'warn' as const }, { value: 'done', label: '', tone: null }] }
    expect(payloadOf(f, ['stage'])).toEqual({
      key: 'stage-2', label: 'Stage', type: 'choice', description: 'Where the work is', hint: null, width: 'm', align: 'start', card: 'meta',
      options: [{ value: 'in-review', label: 'In review', tone: 'warn' }, { value: 'done', label: 'done', tone: null }],
    })
  })
  it('sends null options for other types, and keeps a key typed under More', () => {
    const f = { ...formOf(STAGE), type: 'text' as const, key: 'phase' }
    expect(payloadOf(f, [])).toMatchObject({ key: 'phase', type: 'text', options: null })
  })
  it('makes blank option values unique among the options', () => {
    const f = { ...formOf(), label: 'Stage', type: 'choice' as const, options: [
      { value: '', label: 'Dev', tone: null }, { value: '', label: 'dev', tone: null }, { value: 'dev-2', label: 'Taken', tone: null }] }
    expect(payloadOf(f, []).options!.map((o) => o.value)).toEqual(['dev', 'dev-3', 'dev-2'])
  })
  it('keeps the current key on Edit when Key is emptied; derives only for a new field', () => {
    expect(payloadOf({ ...formOf(STAGE), label: 'Phase', key: '' }, [], 'stage').key).toBe('stage')
    expect(payloadOf({ ...formOf(), label: 'Phase', key: '' }, []).key).toBe('phase')
  })
  it('round-trips a field through the form', () => {
    const p = payloadOf(formOf(STAGE), [])
    expect(p).toMatchObject({ key: 'stage', label: 'Stage', type: 'choice', options: STAGE.options })
  })
})

describe('moveItem', () => {
  it('swaps with the neighbour, and ignores a move off either end', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
  })
})

it('names a field column by the field id', () => {
  expect(fieldColId(STAGE)).toBe('field:f1')
})

describe('writeLayout', () => {
  it('writes over settings as they are now: a view saved on the Work page since, its current view and filter stay', async () => {
    vi.useFakeTimers()
    settings.value = {}
    await loadWork()
    // Settings opens and reads the store; then the Work page saves a view and makes it current, showing all.
    const settingsSnapshot = loadStore(IDS)
    saveStore({ ...saveAs(loadStore(IDS), 'Mine', 'all', IDS, 'v1'), show: 'all' })
    const next = writeLayout(IDS, (l, ids) => setShown(l, ids, 'cost', false))
    await vi.advanceTimersByTimeAsync(1000)
    expect(settingsSnapshot.views).toEqual([])
    expect(next.views.map((v) => v.id)).toEqual(['v1'])
    const stored = settings.value.workViews as Record<string, { name?: string; current?: string; show: string; cols: string[] }>
    expect(stored.v1?.name).toBe('Mine')
    expect(stored.work).toMatchObject({ current: 'v1', show: 'all' })
    expect(stored.work.cols).not.toContain('cost')
    vi.useRealTimers()
  })

  // A layout stored by the Work page with both fields: stage hidden, widths set, both seen.
  const seed = async () => {
    vi.useFakeTimers()
    settings.value = {}
    localStorage.clear()
    await loadWork()
    const base = { ...loadStore(IDS), layout: defaultLayout(IDS) }
    saveStore({ ...base, layout: { ...setShown(base.layout, IDS, 'field:f1', false), widths: { status: 120, 'field:f2': 200 } } }, IDS, true)
    await vi.advanceTimersByTimeAsync(1000)
  }
  const stored = () => settings.value.workViews.work as unknown as { cols: string[]; seen?: string[] }
  const widths = () => JSON.parse(localStorage.getItem('stam/work-widths') ?? '{}')['']

  it('a save with the fields loaded keeps stored widths, seen entries and hidden columns', async () => {
    await seed()
    writeLayout(IDS, (l, ids) => setShown(l, ids, 'cost', false), true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(stored().cols).toEqual(['work', 'status', 'agents', 'field:f2'])
    expect(stored().seen).toEqual(['f1', 'f2'])
    expect(widths()).toEqual({ status: 120, 'field:f2': 200 })
    vi.useRealTimers()
  })

  it('a field added in Settings is in cols and seen', async () => {
    await seed()
    const added = field('f3', 'owner', 2)
    const ids = workColumnIds(BUILTIN, [...FIELDS, added])
    writeLayout(ids, (l) => l, true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(stored().cols).toEqual(['work', 'status', 'agents', 'cost', 'field:f2', 'field:f3'])
    expect(stored().seen).toEqual(['f1', 'f2', 'f3'])
    vi.useRealTimers()
  })

  it('a field removed in Settings leaves cols, seen and widths', async () => {
    await seed()
    writeLayout(workColumnIds(BUILTIN, [STAGE]), (l) => l, true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(stored().cols).not.toContain('field:f2')
    expect(stored().seen).toEqual(['f1'])
    expect(widths()).toEqual({ status: 120 })
    vi.useRealTimers()
  })

  it('an ordinary change with a stale field list keeps a newer field: hidden, seen and its width', async () => {
    await seed()
    // The Work page, which knows f3, hid it and resized it; Settings still has only f1 and f2.
    const wide = workColumnIds(BUILTIN, [...FIELDS, field('f3', 'owner', 2)])
    const base = loadStore(wide)
    saveStore({ ...base, layout: { ...setShown(base.layout, wide, 'field:f3', false), widths: { ...base.layout.widths, 'field:f3': 150 } } }, wide, true)
    await vi.advanceTimersByTimeAsync(1000)
    writeLayout(IDS, (l, ids) => setShown(l, ids, 'cost', false))
    await vi.advanceTimersByTimeAsync(1000)
    expect(stored().cols).not.toContain('field:f3')
    expect(stored().cols).not.toContain('cost')
    expect(stored().seen).toContain('f3')
    expect(widths()['field:f3']).toBe(150)
    vi.useRealTimers()
  })
})
