// @vitest-environment jsdom
// The resting badge (S-2110): what a resting agent waits for and when it wakes, in the viewer's local clock.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stateOf, treeAgents } from './format'
import { setData } from './store'
import type { Agent, Resting } from './types'
import { RestBadge, restParts, restText, wakeAt } from './waits'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const wait = (o: Partial<Resting['waits'][number]> = {}) => ({ id: 'w1', kind: 'event', target: null, detail: 'PR #12', since: '2026-10-18T11:00:00Z', until: null, ...o })
const resting = (o: Partial<Resting> = {}): Resting => ({ reason: 'wait', waits: [wait()], expected_wake: '2026-10-18T14:20:00Z', ...o })
const agent = (r: Resting | null): Agent => ({
  id: 'a1', name: 'lead', harness: 'claude', model: 'm', lifecycle: 'paused', machine: 'alpha', cwd: '/w',
  created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z', parents: [], resting: r,
} as Agent)

// The local clock of the test machine, so the expectation holds in any time zone.
const local = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

let host: HTMLDivElement, root: Root
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse('2026-10-18T12:00:00Z')); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })

describe('resting text', () => {
  const now = Date.parse('2026-10-18T12:00:00Z')
  it('says the wait and the wake time in the local clock', () => {
    expect(restText(resting(), now)).toBe(`resting · waits for PR #12 · wakes ~${local('2026-10-18T14:20:00Z')}`)
  })
  it('leaves the time out when the wake is unknown', () => {
    expect(restText(resting({ expected_wake: null }), now)).toBe('resting · waits for PR #12')
    expect(restParts(resting({ expected_wake: null }), now).wake).toBeNull()
  })
  it('says idle with no wait, and counts the further waits', () => {
    expect(restText(resting({ reason: 'idle', waits: [], expected_wake: null }), now)).toBe('resting · idle')
    expect(restParts(resting({ waits: [wait({ kind: 'timer', detail: null, target: null }), wait({ id: 'w2', kind: 'human', detail: null })] }), now).wait).toBe('waits for you +1')
  })
  it('names the day when the wake is not today', () => {
    expect(wakeAt('2026-10-20T14:20:00Z', now)).toMatch(/\S+ \d\d:\d\d$/)
    expect(wakeAt('2026-10-18T14:20:00Z', now)).toBe(local('2026-10-18T14:20:00Z'))
  })
})

describe('RestBadge', () => {
  const mount = async (a: Agent, compact: boolean | 'icon' = false) => { setData({ agents: [a] }); await act(async () => { root.render(<RestBadge a={a} mode={compact === 'icon' ? 'icon' : compact ? 'compact' : 'full'} />) }) }
  it('shows the wait and the time', async () => {
    await mount(agent(resting()))
    const b = host.querySelector('.rest-badge')!
    expect(b.textContent).toBe(`waits for PR #12 · wakes ~${local('2026-10-18T14:20:00Z')}`)
    expect(b.getAttribute('aria-label')).toContain('resting')
  })
  it('shows only the wait with no expected wake', async () => {
    await mount(agent(resting({ expected_wake: null })))
    expect(host.querySelector('.rest-badge')!.textContent).toBe('waits for PR #12')
  })
  it('compact shows the time alone, and nothing with no wake', async () => {
    await mount(agent(resting()), true)
    expect(host.querySelector('.rest-badge')!.textContent).toBe(`~${local('2026-10-18T14:20:00Z')}`)
    await mount(agent(resting({ expected_wake: null })), true)
    expect(host.querySelector('.rest-badge')!.textContent).toBe('')
    expect(host.querySelector('.rest-badge')!.getAttribute('title')).toContain('waits for PR #12')
  })
  it('icon shows the mark alone, with the whole line in its label', async () => {
    await mount(agent(resting()), 'icon')
    const b = host.querySelector('.rest-badge')!
    expect(b.textContent).toBe('')
    expect(b.getAttribute('aria-label')).toBe(restText(resting()))
  })
  it('renders nothing for an agent that is not resting', async () => {
    await mount(agent(null))
    expect(host.querySelector('.rest-badge')).toBeNull()
  })
})

describe('resting state', () => {
  it('is its own state, and a resting agent stays in the tree', () => {
    const a = agent(resting())
    expect(stateOf(a)).toBe('resting')
    expect(stateOf(agent(null))).toBe('paused')
    expect(treeAgents([a])).toHaveLength(1)
  })
})
