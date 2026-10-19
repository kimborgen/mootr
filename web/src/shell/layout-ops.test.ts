// The web imports the daemon's pure layout module: the same ops apply in both places.
import { describe, expect, it } from 'vitest'
import { apply, emptyLayout, type Layout, type LayoutOp } from '../../../src/layout-ops.ts'

describe('layout ops in the web bundle', () => {
  it('opens a tab in the home world and focuses it', () => {
    let l: Layout = emptyLayout()
    let n = 0
    const id = () => 'x' + n++
    l = apply(l, { op: 'open', world: 'main', key: 'agent:a' }, id)
    const w = l.agentWorlds['_home']
    expect(w).toBeDefined()
    expect(l.version).toBe(1)
    expect(w.root.split).toBeUndefined()
    if (w.root.split) throw new Error('unreachable')
    expect(w.root.tabs).toEqual(['agent:a'])
    expect(w.focused).toBe(w.root.id)
  })

  it('applies ops without mutating its input', () => {
    const before: Layout = emptyLayout()
    const snapshot = JSON.stringify(before)
    const ops: LayoutOp[] = [{ op: 'current', world: 'a1' }, { op: 'open', world: 'main', key: 'k' }]
    const after = ops.reduce((l, op) => apply(l, op), before)
    expect(JSON.stringify(before)).toBe(snapshot)
    expect(after.current).toBe('a1')
  })
})
