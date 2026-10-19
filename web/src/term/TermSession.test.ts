// @vitest-environment jsdom
// A terminal kept beside its agent's conversation (S-166) makes no tmux attach while the
// conversation shows: hide() closes the socket, and nothing reconnects it until show().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setData } from '../store'
import type { Agent } from '../types'

// xterm needs a real renderer; the session only needs its write/reset/open surface here.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100; rows = 30; options: Record<string, unknown> = {}
    loadAddon() {} onData() { return { dispose() {} } } open() {} reset() {} write() {} resize() {} focus() {} blur() {} dispose() {}
  },
}))
// The socket opens with a one-time ticket from the daemon (S-742).
vi.mock('../api', async (orig) => ({ ...(await orig<typeof import('../api')>()), api: vi.fn(async () => ({ ticket: 'T' })) }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return undefined } fit() {} } }))

const { TermSession, centreOffset, sizedElsewhere } = await import('./TermSession')

class FakeSocket {
  static opened: FakeSocket[] = []
  readyState = 0
  binaryType = ''
  onmessage: unknown = null
  onopen: unknown = null
  onclose: unknown = null
  closed = false
  url: string
  constructor(url: string) { this.url = url; FakeSocket.opened.push(this) }
  send() {}
  close() { this.closed = true; this.readyState = 3 }
}

const AGENT: Agent = { id: 'oc', name: 'builder', harness: 'opencode', lifecycle: 'active', activity: 'working', machine: 'alpha', cwd: '/w', created_at: '', updated_at: '', view: { can_stream: true, can_send: true, can_interrupt: true, can_approve: true } } as Agent

describe('a terminal beside its own conversation', () => {
  let shown: boolean
  beforeEach(() => {
    FakeSocket.opened = []
    shown = true
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    setData({ agents: [AGENT] } as never)
    // Visible in the pane until the test hides it: the layout's view of the element.
    vi.spyOn(TermSession.prototype, 'visible').mockImplementation(() => shown)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('attaches when shown, closes on hide, and attaches again only when shown', async () => {
    const s = new TermSession('oc')
    s.show()
    await vi.waitFor(() => expect(FakeSocket.opened.length).toBe(1))
    expect(FakeSocket.opened[0].url).toContain('ticket=T')
    expect(FakeSocket.opened[0].url).not.toContain('token=')
    const first = FakeSocket.opened[0]

    // The conversation takes the pane: the layout hides the terminal, and the socket goes.
    shown = false
    s.hide()
    expect(first.closed).toBe(true)
    // The agent's updates reconnect a terminal that's running, unless it's paused.
    s.sync()
    s.sync()
    expect(FakeSocket.opened.length).toBe(1)

    // The terminal shows again: it attaches.
    shown = true
    s.show()
    await vi.waitFor(() => expect(FakeSocket.opened.length).toBe(2))
    expect(FakeSocket.opened[1].closed).toBe(false)
    s.destroy()
  })
})

// The pure parts of the shared size: when the hint shows, and where a screen sits in its pane.
describe('the size another viewer shares', () => {
  it('is elsewhere only when it differs from the size this viewer claimed', () => {
    expect(sizedElsewhere([80, 24], [80, 24])).toBe(false)
    expect(sizedElsewhere([80, 24], [100, 30])).toBe(true)
    expect(sizedElsewhere([80, 24], [80, 30])).toBe(true)
    // Nothing shared yet, or nothing claimed by this viewer, is no other's size.
    expect(sizedElsewhere(null, [80, 24])).toBe(false)
    expect(sizedElsewhere([80, 24], null)).toBe(false)
  })

  it('centres a smaller screen in its pane and never offsets past the start edge', () => {
    expect(centreOffset(1000, 600)).toBe(200)
    expect(centreOffset(1001, 600)).toBe(200)
    expect(centreOffset(600, 600)).toBe(0)
    expect(centreOffset(500, 600)).toBe(0)
  })
})
