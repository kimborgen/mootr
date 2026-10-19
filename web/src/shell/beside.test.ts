// Which terminals stay detached while their conversation is on screen (S-166).
import { describe, expect, it } from 'vitest'
import { beside } from './beside'
import type { Leaf } from './layout'

const leaf = (id: string, tabs: string[], active: string | null): Leaf => ({ id, tabs, active })

describe('beside', () => {
  it('detaches a phone pane\'s terminal when the focused pane shows its conversation', () => {
    const p1 = leaf('p1', ['agent:A'], 'agent:A')
    const p2 = leaf('p2', ['view:A'], 'view:A')
    // Focused on pane 2: pane 1 is not on screen, so its terminal is detached.
    expect(beside([p1, p2], [p2])).toEqual({ show: ['view:A'], hide: ['agent:A'] })
  })

  it('keeps the terminal attached when focus goes back to its pane', () => {
    const p1 = leaf('p1', ['agent:A'], 'agent:A')
    const p2 = leaf('p2', ['view:A'], 'view:A')
    expect(beside([p1, p2], [p1])).toEqual({ show: ['agent:A'], hide: [] })
  })

  it('detaches the terminal after a desktop to phone switch with the views in separate panes', () => {
    const p1 = leaf('p1', ['agent:A'], 'agent:A')
    const p2 = leaf('p2', ['view:A'], 'view:A')
    // Desktop: both panes shown, so nothing is detached.
    expect(beside([p1, p2], [p1, p2])).toEqual({ show: ['agent:A', 'view:A'], hide: [] })
    // Phone: only the conversation's pane is shown.
    expect(beside([p1, p2], [p2])).toEqual({ show: ['view:A'], hide: ['agent:A'] })
  })

  it('detaches a hidden tab of the same pane, and leaves other agents alone', () => {
    const p1 = leaf('p1', ['agent:A', 'view:A'], 'view:A')
    const p2 = leaf('p2', ['agent:B', 'view:C'], 'agent:B')
    expect(beside([p1, p2], [p1, p2])).toEqual({ show: ['view:A', 'agent:B'], hide: ['agent:A'] })
  })
})
