// The deck's done sheets (S-463, S-462): which ITSAs a sheet carries, and letting go of those
// reopened or moved mid-flight, so no roll-up waits for them. jsdom, with the flight token
// stubbed, since jsdom reads no CSS.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Deck } from './deck'
import { treeLayout, type TreeIn } from './layout'

const NODES: TreeIn[] = [{ id: 'h', parent: null }, { id: 'p', parent: 'h' }, { id: 'a', parent: 'p' }, { id: 'b', parent: 'p' }]
const laid = treeLayout(NODES, { w: 200, h: 100, gapX: 20, gapY: 50, indent: 20, rowGap: 10 })

function deckOf() {
  const layer = document.createElement('div'), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  document.body.append(layer, svg)
  const onChange = vi.fn()
  const deck = new Deck(layer, svg as SVGSVGElement, onChange, () => 0)
  // Flights take the flight token's time; the burst window is closed, so each launch flies alone.
  deck.ms = (t: string) => (t === '--duration-flight' ? 880 : 0)
  deck.geo = { laid, parentOf: (id) => NODES.find((n) => n.id === id)?.parent ?? null, card: 200, cardH: 100, pad: 16, rowGap: 10, sheetH: 12, landIn: 0, human: 'h' }
  return { deck, layer, onChange }
}

beforeEach(() => { vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {}) })
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('Deck.dropDone', () => {
  it('lets go of a carried ITSA that is stale, keeps the rest, and redraws once', () => {
    const { deck, layer, onChange } = deckOf()
    deck.done('a', 'p', 'k1', 'P')
    deck.done('b', 'p', 'k2', 'P')
    expect([...deck.doneKids.keys()].sort()).toEqual(['k1', 'k2'])
    expect(layer.querySelectorAll('.sv-fly.done').length).toBeGreaterThan(0)
    onChange.mockClear()
    // k1 reopened: no longer done under P.
    deck.dropDone((child) => child === 'k1')
    expect([...deck.doneKids.keys()]).toEqual(['k2'])
    expect(onChange).toHaveBeenCalledTimes(1)
    // Nothing stale: nothing changes, and nothing redraws.
    onChange.mockClear()
    deck.dropDone(() => false)
    expect([...deck.doneKids.keys()]).toEqual(['k2'])
    expect(onChange).not.toHaveBeenCalled()
    deck.stop()
  })

  it('takes a dropped ITSA off the sheet that carries it, whose count follows', () => {
    const { deck, layer } = deckOf()
    // Two children done from one card in one burst share a sheet with a count.
    deck.ms = (t: string) => (t === '--duration-flight' ? 880 : t === '--duration-tick' ? 400 : 0)
    deck.done('a', 'p', 'k1', 'P')
    deck.done('a', 'p', 'k2', 'P')
    const sheets = layer.querySelectorAll('.sv-fly.done')
    expect(sheets.length).toBe(1)
    expect(sheets[0].querySelector('.n')?.textContent).toBe('2')
    // k2 moved under another parent mid-flight: the sheet carries k1 alone, and still lands.
    deck.dropDone((child, parent) => child === 'k2' && parent === 'P')
    expect([...deck.doneKids.keys()]).toEqual(['k1'])
    expect(layer.querySelector('.sv-fly.done .n')?.textContent).toBe('')
    deck.stop()
  })
})
