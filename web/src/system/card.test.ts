import { afterEach, describe, expect, it } from 'vitest'
import { setData } from '../store'
import type { Agent } from '../types'
import { activityOf, type CardModel, cardSig } from './SystemCard'
import type { Badge } from './model'

// Only the fields a card reads; the rest of Agent is not needed here.
const agent = (over: Partial<Agent> & { id: string; name: string }) => ({ role: '', lifecycle: 'active', state: 'waiting', created_at: '2026-10-01T00:00:00Z', kind: null, parents: [], ...over }) as unknown as Agent
const model = (a: Agent, badges: Badge[] = []): CardModel => ({ id: a.id, short: a.name, agent: a, activity: activityOf(a), it: null, owns: 0, badges, unread: 0, ctx: 0, ctxLevel: 0, kids: 0, folded: null, hit: '', rollup: null })

afterEach(() => setData({ agents: [] }))

// A card redraws only when its signature changes (SystemCard's memo, S-671): the signature holds
// everything it draws, including what comes from other agents.
describe('cardSig', () => {
  it('changes when the agent a wait is for is renamed', () => {
    const w = agent({ id: 'w1', name: 'dev', waits: [{ kind: 'agent', target: 't1' }] } as Partial<Agent> & { id: string; name: string })
    setData({ agents: [w, agent({ id: 't1', name: 'reviewer' })] })
    const before = model(w)
    expect(before.activity).toBe("Waiting for reviewer's reply")
    setData({ agents: [w, agent({ id: 't1', name: 'checker' })] })
    const after = model(w)
    expect(after.activity).toBe("Waiting for checker's reply")
    expect(cardSig(after)).not.toBe(cardSig(before))
  })

  it('changes with a word badge\'s title and a field badge\'s field', () => {
    const a = agent({ id: 'a1', name: 'dev' })
    const word = (title: string): Badge => ({ kind: 'word', id: 'health', word: 'at risk', tone: 'warn', title })
    expect(cardSig(model(a, [word('Health: at risk')]))).not.toBe(cardSig(model(a, [word('Health: at risk since noon')])))
    const field = (label: string) => ({ kind: 'field', id: 'field:stage', f: { id: 'stage', label }, v: 'dev' }) as unknown as Badge
    expect(cardSig(model(a, [field('Stage')]))).not.toBe(cardSig(model(a, [field('Phase')])))
  })
})
