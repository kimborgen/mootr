// @vitest-environment jsdom
// S-705: useFolds starts with nothing folded, at any size and any number of agents; folding is
// the human's own action, and it is kept per viewer, the desktop's apart from the phone's.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TreeIn } from './layout'
import { useFolds, type Folds } from './useScale'

// human > cos > 30 managers > 9 agents each: 301 agents, past the 60 that used to fold managers.
function tree(): TreeIn[] {
  const out: TreeIn[] = [{ id: 'human', parent: null }, { id: 'cos', parent: 'human' }]
  for (let m = 0; m < 30; m++) {
    out.push({ id: `m${m}`, parent: 'cos' })
    for (let k = 0; k < 9; k++) out.push({ id: `m${m}d${k}`, parent: `m${m}` })
  }
  return out
}
const sig = (nodes: TreeIn[]) => nodes.map((n) => `${n.id}<${n.parent}`).join(' ')
const stored = () => JSON.parse(localStorage.getItem('stam/system-folds') ?? '{}')

let host: HTMLElement, root: Root, folds: Folds, nodes: TreeIn[], narrow = false
function Probe() { folds = useFolds(nodes, sig(nodes), narrow); return null }
const render = () => act(() => root.render(<Probe />))

beforeEach(() => {
  localStorage.clear()
  nodes = tree()
  narrow = false
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  render()
})
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = '' })

describe('useFolds', () => {
  it('starts with nothing folded, at 300 agents and on the phone', () => {
    expect(nodes.length - 1).toBe(301)
    expect([...folds.folded]).toEqual([])
    narrow = true
    render()
    expect([...folds.folded]).toEqual([])
  })

  it('folds only on the human\'s own toggle, kept per viewer', () => {
    act(() => folds.toggle('m0'))
    expect([...folds.folded]).toEqual(['m0'])
    expect(stored()).toEqual({ wide: { m0: true } })
    act(() => folds.toggle('m0'))
    expect([...folds.folded]).toEqual([])
    // The phone keeps its own folds: one made there leaves the desktop's alone.
    narrow = true
    render()
    expect([...folds.folded]).toEqual([])
    act(() => folds.toggle('m0'))
    expect([...folds.folded]).toEqual(['m0'])
    expect(stored().narrow).toEqual({ m0: true })
    narrow = false
    render()
    expect([...folds.folded]).toEqual([])
  })
})
