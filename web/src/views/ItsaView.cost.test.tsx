// @vitest-environment jsdom
// The ITSA view's cost line (S-319): own and total in the user's chosen unit, paid spend in real
// dollars beside it, and '–' with its reason when a value is null.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CostMode, CostModes } from '../types'

const apiMock = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({ api: apiMock }))

import { CostLine } from './ItsaView'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const modes = (over: Partial<CostModes> = {}): CostModes => ({ api: 1.5, five_hour: 3.4, seven_day: 0.4, subscription: 2, paid_usd: 0, ...over })
const reply = (mode: CostMode, own: CostModes, total: CostModes) => ({
  note: 'note', own: { cost_usd: 1.5 }, total: { cost_usd: 4 }, agents: [], config: null, weekly_percent: null,
  cost: { mode, own, total },
})

let host: HTMLDivElement
let root: Root
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
async function render(body: object) {
  apiMock.mockResolvedValue(body)
  await act(async () => { root.render(<CostLine id="i1" />) })
  await flush()
  return host.querySelector('[data-prop="cost"]') as HTMLButtonElement
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  apiMock.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('ITSA cost line', () => {
  it('shows API-equivalent dollars, own and with children', async () => {
    const button = await render(reply('api', modes({ api: 1.5 }), modes({ api: 4 })))
    expect(apiMock).toHaveBeenCalledWith('GET', '/api/itsas/i1/cost')
    expect(button.textContent).toBe('$1.5 · $4.0 with children')
  })

  it('shows the subscription share in dollars', async () => {
    const button = await render(reply('subscription', modes({ subscription: 2 }), modes({ subscription: 7.25 })))
    expect(button.textContent).toBe('$2.0 · $7.3 with children')
  })

  it('shows the 5h window as a percent of its worth', async () => {
    const button = await render(reply('five_hour', modes({ five_hour: 3.4 }), modes({ five_hour: 12 })))
    expect(button.textContent).toBe('3% · 12% with children')
  })

  it('shows the 7d window as a percent, under 1% as <1%', async () => {
    const button = await render(reply('seven_day', modes({ seven_day: 0.4 }), modes({ seven_day: 0.4 })))
    expect(button.textContent).toBe('<1% · <1% with children')
  })

  it('shows paid spend as real dollars beside the converted value', async () => {
    const button = await render(reply('api', modes({ api: 1.5, paid_usd: 1.25 }), modes({ api: 4, paid_usd: 1.25 })))
    expect(button.textContent).toBe('$1.5 + $1.25 paid · $4.0 + $1.25 paid with children')
  })

  it('shows – with the reason when the value is null', async () => {
    const button = await render(reply('five_hour', modes({ five_hour: null }), modes({ five_hour: null })))
    expect(button.textContent).toBe('– · – with children')
    const dashes = button.querySelectorAll('span[title]')
    expect(dashes.length).toBe(2)
    expect(dashes[0]!.getAttribute('title')).toBe('no price set, or not calibrated yet')
  })

  it('shows the week share only in the dollar modes', async () => {
    const button = await render({ ...reply('five_hour', modes({ five_hour: 3.4 }), modes({ five_hour: 3.4 })), weekly_percent: 0.42 })
    expect(button.textContent).toBe('3% · 3% with children')
  })

  it('falls back to dollars from an older daemon with no cost field', async () => {
    const { cost: _cost, ...older } = reply('api', modes(), modes())
    const button = await render({ ...older, weekly_percent: 0.42 } as never)
    expect(button.textContent).toBe('$1.50 · $4.00 with children · 0.42% of week')
  })

  it('shows nothing when the ITSA has no spend', async () => {
    const button = await render({ ...reply('api', modes(), modes()), total: { cost_usd: 0 } })
    expect(button).toBeNull()
  })
})
