import { beforeEach, describe, expect, it } from 'vitest'
import { bottomTarget } from './composer-target'
import { setData } from './store'
import type { Agent } from './types'

const ag = (id: string, name: string, o: Partial<Agent> = {}) => ({ id, name, kind: 'agent', lifecycle: 'active', activity: 'idle', created_at: id, parents: [], ...o }) as unknown as Agent
beforeEach(() => {
  setData({ agents: [ag('a1', 'dev'), ag('gone', 'old', { lifecycle: 'archived' }), ag('c1', 'boss', { chief_of_staff: true })], itsas: [{ id: 'i1', key: 'S-7', title: 'Thing' }] as never })
})

describe('bottomTarget: the main world in, the bottom input\'s target out', () => {
  it('an agent, its conversation and its own tabs write to the agent', () => {
    expect(bottomTarget('agent:a1')).toEqual({ kind: 'agent', key: 'agent:a1', name: 'dev', to: 'a1', enabled: true })
    expect(bottomTarget('view:a1')).toMatchObject({ kind: 'agent', key: 'view:a1', to: 'a1' })
    for (const tab of ['mail', 'details', 'instructions', 'inventory']) expect(bottomTarget(`${tab}:a1`)).toMatchObject({ kind: 'agent', key: 'agent:a1', to: 'a1', enabled: true })
  })
  it('a staged image tab keeps the target of what the main world showed before it', () => {
    bottomTarget('agent:a1')
    expect(bottomTarget('image:i1')).toMatchObject({ kind: 'agent', key: 'agent:a1' })
    bottomTarget('thread:t9')
    expect(bottomTarget('image:i2')).toMatchObject({ kind: 'thread', key: 'thread:t9' })
    bottomTarget('view:a1')
    expect(bottomTarget('image:i3')).toMatchObject({ kind: 'agent', key: 'view:a1', enabled: true })
    bottomTarget('shell:m:s1')
    expect(bottomTarget('image:i4')).toMatchObject({ kind: 'shell', enabled: true })
    bottomTarget('itsa:i1')
    expect(bottomTarget('image:i5')).toMatchObject({ kind: 'itsa', enabled: true })
  })
  it('an agent that is not running is a disabled target; one that is gone is none', () => {
    expect(bottomTarget('agent:gone')).toMatchObject({ kind: 'agent', enabled: false })
    expect(bottomTarget('agent:nobody')).toMatchObject({ kind: 'none' })
  })
  it('a terminal, a thread and an ITSA', () => {
    expect(bottomTarget('shell:m1:s1')).toMatchObject({ kind: 'shell', to: 's1' })
    expect(bottomTarget('thread:t1')).toMatchObject({ kind: 'thread', key: 'thread:t1', to: 't1' })
    expect(bottomTarget('itsa:i1')).toEqual({ kind: 'itsa', key: 'itsa:i1', name: 'S-7 Thing', to: 'i1', enabled: true })
  })
  it('Work writes to the chief of staff, and is none without one', () => {
    expect(bottomTarget('work')).toMatchObject({ kind: 'chief', to: 'c1', name: 'boss' })
    setData({ agents: [] })
    expect(bottomTarget('work')).toMatchObject({ kind: 'none', context: 'Work · no chief of staff' })
  })
  it('Settings, Usage, Process, a requirement and nothing are none, with a one-line context', () => {
    expect(bottomTarget('config')).toEqual({ kind: 'none', world: 'config', context: 'Settings' })
    expect(bottomTarget('usage')).toMatchObject({ kind: 'none', context: expect.stringMatching(/^Usage · \w+$/) })
    expect(bottomTarget('process')).toMatchObject({ kind: 'none', context: 'Process' })
    expect(bottomTarget('req:r1')).toMatchObject({ kind: 'none', context: 'A requirement' })
    expect(bottomTarget(null)).toEqual({ kind: 'none', world: null, context: 'Nothing selected' })
    for (const w of ['config', 'usage', 'process', 'req:r1', null]) expect((bottomTarget(w) as { context: string }).context).not.toMatch(/\n/)
  })
  it('the inbox and views with no input are named as their tab is, never by their key', () => {
    setData({ agents: [ag('a1', 'dev')], itsas: [{ id: 'i1', key: 'S-7', title: 'Thing' }] as never })
    const ctx = (w: string) => (bottomTarget(w) as { kind: string; context: string })
    expect(ctx('mail:human')).toMatchObject({ kind: 'none', context: 'Your inbox' })
    expect(ctx('board:all').context).toBe('All issues')
    expect(ctx('board:i1').context).toBe('S-7 board')
    expect(ctx('type:reviewer').context).toBe('reviewer · type')
    expect(ctx('file:host1:/a/b/c.ts').context).toBe('c.ts')
    expect(ctx('system').context).toBe('System')
    expect(ctx('swipe').context).toBe('Swipe')
    expect(ctx('files').context).toBe('Files')
    expect(ctx('compliance').context).toBe('Compliance')
    expect(ctx('somethingnew:x').context).toBe('Another view')
  })
})
