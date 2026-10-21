// The live word an open own view leaves for its agent (ownview-live.ts). The same agent can be open
// in the main world and the top world at once: closing one must not take the other's Stop (S-1774).
import { describe, expect, it } from 'vitest'
import { clearLive, getLive, setLive, type Live } from './ownview-live'

const LIVE = (over: Partial<Live> = {}): Live => ({ running: true, asking: false, stop: () => {}, stopError: '', ...over })

describe('ownview-live: one word per open view', () => {
  it('keeps the other view\'s Stop when one of two open views of the agent closes', () => {
    const main = {}, top = {}
    const mainStop = LIVE(), topStop = LIVE({ stop: () => {} })
    setLive('oc', main, mainStop)
    setLive('oc', top, topStop)
    expect(getLive('oc')).toBe(topStop)
    clearLive('oc', top)
    expect(getLive('oc')).toBe(mainStop)
    expect(getLive('oc')?.stop).not.toBeNull()
    clearLive('oc', main)
    expect(getLive('oc')).toBeUndefined()
  })

  it('shows the view that spoke last', () => {
    const main = {}, top = {}
    setLive('oc', main, LIVE({ running: false, stop: null }))
    setLive('oc', top, LIVE({ running: true }))
    expect(getLive('oc')?.running).toBe(true)
    setLive('oc', main, LIVE({ running: true, stop: null }))
    expect(getLive('oc')?.stop).toBeNull()
  })

  it('ignores a clear from a view that never set a word', () => {
    const main = {}
    const word = LIVE()
    setLive('oc', main, word)
    clearLive('oc', {})
    clearLive('other', main)
    expect(getLive('oc')).toBe(word)
    clearLive('oc', main)
  })

  it('keeps a view\'s word unchanged when it sets the same one again', () => {
    const main = {}
    const word = LIVE()
    setLive('oc', main, word)
    setLive('oc', main, LIVE({ stop: word.stop }))
    expect(getLive('oc')).toBe(word)
    clearLive('oc', main)
  })
})
