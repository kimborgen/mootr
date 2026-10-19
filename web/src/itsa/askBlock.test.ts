// The blocking line of an ask (askBlock, S-351): what the ask holds and which agents it stops.
// It names only what the waits and the ITSA's status say: an agent is stopped by a reply wait
// tied to the ask's thread, or by a pending permission dialog in it, never by an untied wait.
import { describe, expect, it } from 'vitest'
import { askBlock, askBlockText } from './askBlock'
import type { Agent, ItsaAttention, Permission, Wait } from '../types'

const itsa = (id: string, key: string, askThread: string | null) => ({ id, key, ask_thread_id: askThread }) as unknown as ItsaAttention
const wait = (id: string, thread: string | null, target: string | null = null): Wait => ({ id, kind: 'human', target, thread, since: '2026-10-13T11:00:00Z', source: 'declared' }) as Wait
const agent = (id: string, name: string, waits: Wait[] = []) => ({ id, name, waits }) as unknown as Agent
const perm = (id: string, agentId: string, dialog: number | null = 0) => ({ id, agent_id: agentId, status: 'pending', dialog }) as unknown as Permission
// The thread each permission request's mail is in.
const threads: Record<string, string> = { p1: 'tp1', p2: 'tp2' }
const threadOfPerm = (pid: string) => threads[pid]

describe('askBlock', () => {
  it('holds the ITSA whose ask is the thread, and nothing else', () => {
    const b = askBlock('t1', { attention: [itsa('1', 'S-1', 't1'), itsa('2', 'S-2', 't2')], agents: [], perms: [] }, threadOfPerm)
    expect(b).toEqual({ holds: ['S-1'], stopped: [] })
  })

  it('stops the agent whose reply wait is tied to the thread', () => {
    const b = askBlock('t1', { attention: [], agents: [agent('a1', 'alice', [wait('w1', 't1')])], perms: [] }, threadOfPerm)
    expect(b).toEqual({ holds: [], stopped: ['alice'] })
  })

  it('never stops an agent for an untied wait, or one tied to another thread', () => {
    const b = askBlock('t1', { attention: [], agents: [agent('a1', 'alice', [wait('w1', null), wait('w2', 't2')])], perms: [] }, threadOfPerm)
    expect(b).toEqual({ holds: [], stopped: [] })
  })

  it('never stops an agent for a plain permission request in the thread, which leaves a threadless wait', () => {
    // request_permission: a threadless human wait naming the request, while the agent keeps working.
    const b = askBlock('tp1', { attention: [], agents: [agent('a1', 'alice', [wait('w1', null, 'p1')])], perms: [perm('p1', 'a1', 0)] }, threadOfPerm)
    expect(b).toEqual({ holds: [], stopped: [] })
  })

  it('stops the agent with a pending permission dialog in the thread, and not one with a plain request', () => {
    const b = askBlock('tp1', { attention: [], agents: [agent('a1', 'alice'), agent('a2', 'bob')], perms: [perm('p1', 'a1', 1), perm('p2', 'a2', 0)] }, threadOfPerm)
    expect(b.stopped).toEqual(['alice'])
  })

  it('names each stopped agent once, and holds nothing for no thread', () => {
    const waits = [wait('w1', 't1'), wait('w2', 't1')]
    expect(askBlock('t1', { attention: [], agents: [agent('a1', 'alice', waits)], perms: [] }, threadOfPerm).stopped).toEqual(['alice'])
    expect(askBlock(null, { attention: [itsa('1', 'S-1', null)], agents: [agent('a1', 'alice', [wait('w1', null)])], perms: [] }, threadOfPerm)).toEqual({ holds: [], stopped: [] })
  })
})

describe('askBlockText', () => {
  it('says what the ask holds and what it stops, in words', () => {
    expect(askBlockText({ holds: ['S-351'], stopped: ['alice', 'bob'] })).toBe('Holds S-351 · @alice is stopped until you answer · @bob is stopped until you answer')
  })

  it('is empty when the ask holds and stops nothing', () => {
    expect(askBlockText({ holds: [], stopped: [] })).toBe('')
  })

  it('shortens to who is stopped for a Mail row, and is empty when nobody is', () => {
    expect(askBlockText({ holds: ['S-351'], stopped: ['alice', 'bob'] }, true)).toBe('@alice stopped · @bob stopped')
    expect(askBlockText({ holds: ['S-351'], stopped: [] }, true)).toBe('')
    expect(askBlockText({ holds: [], stopped: [] }, true)).toBe('')
  })
})
