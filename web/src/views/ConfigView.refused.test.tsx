// @vitest-environment jsdom
// A plain save refusal from this daemon (S-737) is said in a toast as well as the status line:
// the status line is hidden on a phone (760 px and under), so a refused save showed nothing there.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyState, installFixtures } from '../stories/fixtures'
import { pressIn, SAVE_REFUSED, settingsRoutes } from '../stories/settingsFixtures'
import { toast } from '../ui/menu'
import { ConfigView } from './ConfigView'

vi.mock('../ui/menu', async (orig) => ({ ...(await orig<typeof import('../ui/menu')>()), toast: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeAll(() => installFixtures())
beforeEach(() => {
  vi.mocked(toast).mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  // jsdom has no matchMedia; the settings page asks it for the phone's layout.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('a refused settings save', () => {
  it('shows the daemon\'s refusal in the status line and as a toast', async () => {
    applyState({ routes: { ...settingsRoutes(), ...SAVE_REFUSED } })
    await act(async () => { root.render(<ConfigView />) })
    await flush()
    await act(async () => { pressIn('Mail to you', 'Everything')(host) })
    // The press waits for its section and button to draw, then the save's answer comes back.
    for (let i = 0; i < 50 && !vi.mocked(toast).mock.calls.length; i++) await flush()

    expect(host.querySelector('.saved')?.textContent).toContain('fixture: settings.json is read-only')
    expect(toast).toHaveBeenCalledWith('fixture: settings.json is read-only', true)
  })
})
