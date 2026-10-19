import { afterEach, describe, expect, it } from 'vitest'
import { nextTopTarget, topTarget, topTargets, topView, setTopTarget } from './actions'
import { setData } from './store'
import { getUi, setUi } from './ui/state'
import type { Agent } from './types'

// Only the fields the switch reads; the rest of Agent is not needed here.
const agent = (over: Partial<Agent> & { id: string; name: string }) => ({ role: '', lifecycle: 'active', state: 'idle', created_at: '2026-10-01T00:00:00Z', kind: null, parents: [], ...over }) as unknown as Agent
const cos = agent({ id: 'cos1', name: 'cos', chief_of_staff: true })
const helper = agent({ id: 'help1', name: 'helper', chief_of_staff: true, parents: [] })
const intake = agent({ id: 'aa5sp', name: 'intake', role: "cos's intake assistant: triages Dana's ideas", parents: ['cos1'], created_at: '2026-10-02T00:00:00Z' })
const notAssistant = agent({ id: 'w1', name: 'worker', role: 'developer', parents: ['cos1'] })
const exec = agent({ id: 'exec1', name: 'assistant', kind: 'assistant', role: 'Executive assistant' })

afterEach(() => { setData({ agents: [], assistantDefault: 'assistant' }); setUi({ topTarget: null, topOpen: false }); try { localStorage.clear() } catch {} })

describe('the Assistant tab switch', () => {
  it('offers the executive assistant, then each chief of staff\'s assistant, then the chiefs', () => {
    setData({ agents: [cos, helper, intake, notAssistant, exec] })
    expect(topTargets().map((t) => t.id)).toEqual(['assistant', 'aa5sp', 'cos1', 'help1'])
    expect(topTargets()[1].tag).toBe("chief of staff's assistant")
  })

  it('finds a chief of staff\'s assistant by its role, not its name', () => {
    setData({ agents: [cos, agent({ id: 'x9', name: 'liaison', role: 'the chief\'s assistant', parents: ['cos1'] })] })
    expect(topTargets().map((t) => t.id)).toContain('x9')
  })

  it('remembers the pick and falls back to the executive assistant when it is gone', () => {
    setData({ agents: [cos, intake] })
    setTopTarget('aa5sp')
    expect(topTarget().id).toBe('aa5sp')
    setData({ agents: [cos] })
    expect(topTarget().id).toBe('assistant')
  })

  it('opens on the default from Settings until this device picks another', () => {
    setData({ agents: [cos, intake], assistantDefault: 'intake' })
    expect(topTarget().id).toBe('aa5sp')
    setTopTarget('assistant')
    expect(topTarget().id).toBe('assistant')
  })

  it('falls back to the executive assistant when the default is not running', () => {
    setData({ agents: [cos], assistantDefault: 'intake' })
    expect(topTarget().id).toBe('assistant')
  })
})

describe('Alt+C', () => {
  it('opens on the target last written to, then moves to the next', () => {
    setData({ agents: [cos] })
    setUi({ topTarget: 'cos1' })
    nextTopTarget()
    expect([getUi().topOpen, topTarget().id]).toEqual([true, 'cos1'])
    nextTopTarget()
    expect(topTarget().id).toBe('assistant')
  })
  it('with the assistant alone, opens it and closes it again (Alt+A is the suggesting prompt now)', () => {
    setData({ agents: [] })
    nextTopTarget()
    expect([getUi().topOpen, topTarget().id]).toEqual([true, 'assistant'])
    nextTopTarget()
    expect(getUi().topOpen).toBe(false)
  })
  it('closes the Alt+A prompt when it opens', () => {
    setUi({ suggestOpen: true })
    nextTopTarget()
    expect(getUi().suggestOpen).toBe(false)
  })
})

describe('the Assistant tab view', () => {
  const caps = { can_stream: true, can_send: true, can_interrupt: true, can_approve: true }
  it('shows the agent in its conversation by default, as opening it elsewhere does', () => {
    setData({ agents: [exec], agentView: 'conversation' })
    expect(topView({ ...exec, view: caps, default_view: null } as Agent)).toBe('conversation')
  })
  it('follows Settings for terminal and the agent’s own remembered choice', () => {
    setData({ agents: [exec], agentView: 'terminal' })
    expect(topView({ ...exec, view: caps, default_view: null } as Agent)).toBe('terminal')
    expect(topView({ ...exec, view: caps, default_view: 'conversation' } as Agent)).toBe('conversation')
  })
  it('shows the terminal for an agent with no conversation view, and with no agent', () => {
    setData({ agents: [exec], agentView: 'conversation' })
    expect(topView({ ...exec, view: null } as Agent)).toBe('terminal')
    expect(topView(undefined)).toBe('terminal')
  })
})
