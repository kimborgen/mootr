// The web's copy of the daemon's layout: changes show at once, carry their pane ids so the
// daemon's panes match, give way to the daemon's layout, and wait while it's away. The
// daemon here is a stand-in that applies ops as src/layout.ts does, with its own ids.
import { describe, expect, it, vi } from 'vitest'
import { apply, emptyLayout, leaves, type Layout, type LayoutOp } from '../../../src/layout-ops.ts'
import { LayoutSync, parseEvents, Refused } from './layout-sync'
import { oldLayout } from './layout'

function daemon() {
  let n = 0
  const d = {
    layout: emptyLayout() as Layout,
    // Each request waits until the test lets it through.
    gate: [] as (() => void)[],
    down: false,
    refuse: false,
    // Applies the batch, then loses the reply (the client sees a network error).
    lose: false,
    batches: new Set<string>(),
    apply(ops: LayoutOp[]) {
      let next = d.layout
      for (const op of ops) next = apply(next, op, () => 'd' + n++)
      d.layout = { ...next, version: d.layout.version + 1 }
      return d.layout
    },
    // As src/layout.ts: a batch it applied already is answered as is.
    send: (ops: LayoutOp[], batch: string) => new Promise<Layout>((ok, fail) => {
      d.gate.push(() => {
        if (d.down) return fail(new TypeError('Failed to fetch'))
        if (d.batches.has(batch)) return ok(d.layout)
        if (d.refuse) return fail(new Refused('no pane'))
        let l: Layout
        try { l = d.apply(ops) } catch (e) { return fail(new Refused((e as Error).message)) }
        d.batches.add(batch)
        if (d.lose) fail(new TypeError('Failed to fetch'))
        else ok(l)
      })
    }),
    async release() {
      await flush()
      while (d.gate.length) { d.gate.shift()!(); await flush() }
    },
  }
  return d
}
const flush = () => new Promise((r) => setTimeout(r, 0))
function client(d: ReturnType<typeof daemon>, start = emptyLayout()) {
  let n = 0
  const changed = vi.fn()
  const sent: LayoutOp[][] = []
  const batches: string[] = []
  const s = new LayoutSync(start, { send: (ops, batch) => { sent.push(ops); batches.push(batch); return d.send(ops, batch) }, changed, newId: () => 'c' + n++ })
  return { s, changed, sent, batches }
}
const home = (l: Layout) => l.agentWorlds[l.current ?? '_home']
const tabs = (l: Layout) => leaves(home(l).root).map((x) => x.tabs)

describe('layout sync', () => {
  it('shows a change at once and sends it as ops', async () => {
    const d = daemon()
    const { s, changed, sent } = client(d)
    s.receive(d.layout)
    expect(s.exec([{ op: 'open', world: 'main', key: 'usage' }])).toBe(true)
    expect(tabs(s.view)).toEqual([['usage']])
    expect(changed).toHaveBeenCalledTimes(1)
    await flush()
    expect(sent).toEqual([[{ op: 'open', world: 'main', key: 'usage' }]])
    await d.release()
    expect(s.view).toEqual(d.layout)
  })

  it('gives new panes its own ids, so the daemon\'s panes and focus match', async () => {
    const d = daemon()
    const { s, sent } = client(d)
    s.receive(d.layout)
    s.exec([{ op: 'open', world: 'main', key: 'agent:a' }, { op: 'open', world: 'main', key: 'usage', split: 'right' }])
    const optimistic = JSON.stringify(home(s.view))
    await flush()
    expect(sent[0][1].ids).toEqual(['c0', 'c1'])
    await d.release()
    expect(JSON.stringify(home(d.layout))).toBe(optimistic)
    expect(home(s.view).focused).toBe('c0')
  })

  it('keeps its own change until the daemon confirms it, then follows the daemon', async () => {
    const d = daemon()
    const { s } = client(d)
    s.receive(d.layout)
    s.exec([{ op: 'open', world: 'main', key: 'mine' }])
    // Another client's change arrives first: ours stays on screen meanwhile.
    s.receive(d.apply([{ op: 'open', world: 'main', key: 'theirs' }]))
    expect(tabs(s.view)).toEqual([['mine']])
    await d.release()
    expect(tabs(s.view)).toEqual([['theirs', 'mine']])
    expect(s.view).toEqual(d.layout)
  })

  it('replaces its copy with each layout the stream brings when idle', () => {
    const d = daemon()
    const { s, changed } = client(d)
    s.receive(d.apply([{ op: 'current', world: 'a1' }, { op: 'open', world: 'main', key: 'usage', split: 'right' }]))
    expect(s.view).toEqual(d.layout)
    expect(s.view).not.toBe(d.layout)
    expect(changed).toHaveBeenCalledTimes(1)
    // The same layout again changes nothing.
    s.receive(d.layout)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('drops a change the daemon refuses and shows the daemon\'s layout', async () => {
    const d = daemon()
    const { s } = client(d)
    s.receive(d.layout)
    d.refuse = true
    s.exec([{ op: 'open', world: 'main', key: 'x' }])
    expect(tabs(s.view)).toEqual([['x']])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await d.release()
    warn.mockRestore()
    expect(s.view).toEqual(d.layout)
  })

  it('refuses an op that doesn\'t apply to its copy, sending nothing', async () => {
    const d = daemon()
    const { s, sent } = client(d)
    s.receive(d.layout)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(s.exec([{ op: 'close', world: 'main', key: 'nope' }])).toBe(false)
    warn.mockRestore()
    await flush()
    expect(sent).toEqual([])
  })

  it('keeps working offline and sends what waited, in order, when the stream is back', async () => {
    const d = daemon()
    const { s, sent } = client(d)
    s.receive(d.layout)
    d.down = true
    s.exec([{ op: 'open', world: 'main', key: 'a' }])
    await flush()
    await d.release()
    expect(s.pending()).toBe(1)
    s.disconnected()
    s.exec([{ op: 'open', world: 'main', key: 'b' }])
    await flush()
    expect(sent.length).toBe(1) // b waits; nothing is sent while the daemon is away
    expect(tabs(s.view)).toEqual([['a', 'b']])
    d.down = false
    s.receive(d.layout)
    expect(tabs(s.view)).toEqual([['a', 'b']])
    await flush()
    await d.release()
    expect(sent.slice(1).map((ops) => ops[0].op === 'open' && ops[0].key)).toEqual(['a', 'b'])
    expect(tabs(s.view)).toEqual([['a', 'b']])
    expect(s.view).toEqual(d.layout)
  })

  it('sends a batch whose reply was lost again, and the daemon applies it once', async () => {
    const d = daemon()
    const { s, batches } = client(d)
    s.receive(d.layout)
    d.lose = true
    s.exec([{ op: 'open', world: 'main', key: 'usage', split: 'right' }])
    await d.release()
    expect(d.layout.version).toBe(1)
    expect(s.pending()).toBe(1)
    d.lose = false
    s.disconnected()
    s.receive(d.layout)
    await d.release()
    expect(batches.length).toBe(2)
    expect(batches[1]).toBe(batches[0])
    expect(d.layout.version).toBe(1)
    const ids = leaves(home(d.layout).root).map((x) => x.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(tabs(d.layout)).toEqual([[], ['usage']])
    expect(s.view).toEqual(d.layout)
  })

  it('holds back a batch behind a failed one, and sends both in order when the daemon is back', async () => {
    const d = daemon()
    const { s, sent } = client(d)
    s.receive(d.layout)
    d.down = true
    // A makes a pane (c0); B puts a tab in it, so B only applies after A.
    s.exec([{ op: 'open', world: 'main', key: 'a', split: 'right' }])
    s.exec([{ op: 'open', world: 'main', key: 'b', pane: 'c0' }])
    await d.release()
    expect(sent.length).toBe(1) // B wasn't sent behind the failed A
    d.down = false
    s.disconnected()
    s.receive(d.layout)
    await d.release()
    expect(sent.map((ops) => ops[0].op === 'open' && ops[0].key)).toEqual(['a', 'a', 'b'])
    expect(tabs(d.layout)).toEqual([[], ['a', 'b']])
    expect(s.view).toEqual(d.layout)
  })

  it('keeps the order when the stream breaks while a batch is on its way', async () => {
    const d = daemon()
    const { s, sent } = client(d)
    s.receive(d.layout)
    s.exec([{ op: 'open', world: 'main', key: 'a' }])
    await flush()
    s.disconnected()
    s.exec([{ op: 'open', world: 'main', key: 'c' }])
    d.down = true
    await d.release() // A fails
    d.down = false
    s.receive(d.layout)
    await d.release()
    expect(sent.map((ops) => ops[0].op === 'open' && ops[0].key)).toEqual(['a', 'a', 'c'])
    expect(tabs(d.layout)).toEqual([['a', 'c']])
  })

  it('applies a resize queued behind the change that made its split', async () => {
    const d = daemon()
    const { s } = client(d)
    s.receive(d.layout)
    s.exec([{ op: 'open', world: 'main', key: 'a', split: 'right' }])
    const split = home(s.view).root.id
    s.exec([{ op: 'resize', world: 'main', split, sizes: [3, 1] }])
    await d.release()
    const root = home(d.layout).root
    expect(root.split && root.sizes).toEqual([3, 1])
  })

  it('starts offline from a cached copy and changes it before the daemon answers', async () => {
    const d = daemon()
    d.apply([{ op: 'open', world: 'main', key: 'cached' }])
    const { s, sent } = client(d, d.layout)
    s.exec([{ op: 'open', world: 'main', key: 'new' }])
    expect(tabs(s.view)).toEqual([['cached', 'new']])
    expect(sent).toEqual([])
    s.receive(d.layout)
    await flush()
    await d.release()
    expect(tabs(s.view)).toEqual([['cached', 'new']])
  })

  it('holds its copy while a request of its own runs (the one-time move)', async () => {
    const d = daemon()
    const { s } = client(d)
    const old: Layout = { version: 0, current: 'a1', agentWorlds: { a1: { root: { id: 'x', tabs: ['agent:a1'], active: 'agent:a1' }, focused: 'x' } }, worlds: {} }
    let put!: () => void
    const done = vi.fn()
    s.run(() => new Promise<Layout>((ok) => { put = () => { d.layout = { ...old, version: 1 }; ok(d.layout) } }), done)
    s.view = old
    s.receive(emptyLayout())
    expect(s.view.current).toBe('a1')
    await flush()
    put()
    await flush()
    await flush()
    expect(s.view).toEqual({ ...old, version: 1 })
    expect(done).toHaveBeenCalledWith(true)
  })
})

describe('the earlier shell\'s layout', () => {
  it('becomes a daemon layout without its per-browser fields', () => {
    const raw = { v: 6, open: { left: true, bottom: true }, size: { left: 300 }, current: 'a1', mobile: null, agentWorlds: { a1: { root: { id: 'x', tabs: ['agent:a1'], active: 'agent:a1' }, focused: 'x' } }, worlds: {} }
    expect(oldLayout(raw)).toEqual({ version: 0, current: 'a1', agentWorlds: raw.agentWorlds, worlds: {} })
  })
  it('is ignored when empty or malformed', () => {
    expect(oldLayout(null)).toBeNull()
    expect(oldLayout({ agentWorlds: {} })).toBeNull()
    expect(oldLayout({ agentWorlds: { a1: { root: { id: 'x', split: 'row', children: [], sizes: [] }, focused: 'x' } } })).toBeNull()
  })
})

describe('the layout stream', () => {
  it('parses layout events and keeps a partial one for later', () => {
    const l = emptyLayout()
    const { layouts, rest } = parseEvents(`: ping\n\nevent: layout\ndata: ${JSON.stringify(l)}\n\nevent: layout\ndata: {"ver`)
    expect(layouts).toEqual([l])
    expect(rest).toBe('event: layout\ndata: {"ver')
  })
})
