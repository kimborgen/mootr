// The Agents page's bulk actions (S-3117): which agents each action applies to and its verb, the one toast it ends with
// (a queued archive, the cascade's notes, the failures by name), the concurrency limit, the checked set's pruning and a
// Shift-click's range.
import { describe, expect, it } from 'vitest'
import { applies, confirmNames, keepChecked, mapLimit, noteFor, notesOf, queuedOf, rangeOf, reasonOf, summarize, verbOf, type BulkResult } from './agents-bulk'
import { agent } from './stories/fixtures'

const ACTIVE = agent({ id: 'b-active', name: 'fixture-active', lifecycle: 'active', permission_mode: 'auto', permission_source: 'manual' })
const PAUSED = agent({ id: 'b-paused', name: 'fixture-paused', lifecycle: 'paused', permission_mode: 'auto', permission_source: 'manual' })
const STOPPED = agent({ id: 'b-stopped', name: 'fixture-stopped', lifecycle: 'shut_down', permission_mode: 'auto', permission_source: 'manual' })
const ARCHIVED = agent({ id: 'b-archived', name: 'fixture-archived', lifecycle: 'archived', permission_mode: 'auto', permission_source: 'manual' })

describe('which agents a bulk action applies to', () => {
  it('pauses only the active agents', () => {
    expect([ACTIVE, PAUSED, STOPPED, ARCHIVED].map((a) => applies(a, { kind: 'pause' }))).toEqual([true, false, false, false])
  })

  it('resumes the paused and the stopped agents, with the verb agentMenu uses for each', () => {
    expect([ACTIVE, PAUSED, STOPPED, ARCHIVED].map((a) => applies(a, { kind: 'resume' }))).toEqual([false, true, true, false])
    expect(verbOf(PAUSED, { kind: 'resume' })).toBe('unpause')
    expect(verbOf(STOPPED, { kind: 'resume' })).toBe('resume')
    expect(verbOf(ACTIVE, { kind: 'pause' })).toBe('pause')
  })

  it('archives every agent that is not archived yet', () => {
    expect([ACTIVE, PAUSED, STOPPED, ARCHIVED].map((a) => applies(a, { kind: 'archive' }))).toEqual([true, true, true, false])
    expect(verbOf(ACTIVE, { kind: 'archive' })).toBe('archive')
  })

  it('changes the mode of a live agent that is not in that mode already', () => {
    const bypass = agent({ id: 'b-bypass', name: 'fixture-bypass', lifecycle: 'active', permission_mode: 'bypass', permission_source: 'manual' })
    expect(applies(ACTIVE, { kind: 'mode', mode: 'bypass' })).toBe(true)
    expect(applies(bypass, { kind: 'mode', mode: 'bypass' })).toBe(false)
    expect(applies(STOPPED, { kind: 'mode', mode: 'bypass' })).toBe(false)
    expect(applies(agent({ id: 'b-follow', name: 'fixture-follow', lifecycle: 'active', permission_source: 'settings' }), { kind: 'mode', mode: 'settings' })).toBe(false)
  })
})

describe('the toast a bulk action ends with', () => {
  const ok = (id: string, result?: string): BulkResult => ({ id, name: `fixture-${id}`, ok: true, result })
  const no = (id: string, reason: string): BulkResult => ({ id, name: `fixture-${id}`, ok: false, reason })

  it('counts what was done when every agent succeeded', () => {
    expect(summarize({ kind: 'pause' }, [ok('a'), ok('b'), ok('c'), ok('d'), ok('e')])).toEqual({ text: 'Paused 5', err: false })
  })

  it('names each failure, with its reason, when some agents failed', () => {
    expect(summarize({ kind: 'pause' }, [ok('a'), ok('b'), ok('c'), ok('d'), no('e', 'busy')])).toEqual({ text: 'Paused 4, 1 failed: fixture-e (busy)', err: true })
  })

  it('says nothing was done, and names the failures, when every agent failed', () => {
    expect(summarize({ kind: 'archive' }, [no('a', 'refused'), no('b', 'refused')])).toEqual({ text: "Couldn't archive: fixture-a (refused), fixture-b (refused)", err: true })
  })

  it('names the mode a mode change set', () => {
    expect(summarize({ kind: 'mode', mode: 'bypass' }, [ok('a')])).toEqual({ text: 'Switched 1 to Bypass permissions', err: false })
  })

  it('does not count a pause, resume or mode answer as queued', () => {
    expect(summarize({ kind: 'pause' }, [ok('a', 'paused'), ok('b', 'paused')])).toEqual({ text: 'Paused 2', err: false })
    expect(summarize({ kind: 'resume' }, [ok('a', 'resuming')])).toEqual({ text: 'Resumed 1', err: false })
  })

  it('counts an archive the daemon queued apart from one it finished', () => {
    const waiting = 'waiting for fixture-b to finish its step'
    expect(summarize({ kind: 'archive' }, [ok('a', 'done'), ok('b', waiting)])).toEqual({ text: `Archived 1, 1 queued: fixture-b`, err: false })
    expect(queuedOf(ok('b', waiting))).toBe(true)
    expect(queuedOf(ok('a', 'done'))).toBe(false)
  })

  it('reports a failed child on its own, beside the parent it came with', () => {
    const parent = ok('p', 'done; also archived idle fixture-c1; couldn\'t archive fixture-c2')
    const rs = [parent, ok('c1', 'done'), no('c2', 'busy')]
    expect(summarize({ kind: 'archive' }, rs)).toEqual({
      text: "Archived 2, 1 failed: fixture-c2 (busy). Notes: fixture-p: also archived idle fixture-c1; couldn't archive fixture-c2",
      err: true,
    })
  })
})

describe('the cascade notes of an archive', () => {
  it('reads the notes after the first "; " and names the segment about one agent', () => {
    const r = 'done; also archived idle fixture-1; asked idle fixture-10 for their final round; left alone, now reporting to x: fixture-2'
    expect(notesOf(r)).toBe('also archived idle fixture-1; asked idle fixture-10 for their final round; left alone, now reporting to x: fixture-2')
    expect(notesOf('done')).toBe('')
    expect(noteFor(notesOf(r), 'fixture-1')).toBe('also archived idle fixture-1')
    expect(noteFor(notesOf(r), 'fixture-10')).toBe('asked idle fixture-10 for their final round')
    expect(noteFor(notesOf(r), 'fixture-9')).toBe('')
  })
})

describe('mapLimit', () => {
  it('runs at most the limit at once and keeps the results in the items order', async () => {
    let running = 0
    let most = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 4, async (x: number) => {
      running++
      most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, x % 3))
      running--
      return x * 10
    })
    expect(most).toBe(4)
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70])
  })
})

describe('the checked set', () => {
  it('returns the same set when no checked agent left the list', () => {
    const checked = new Set(['a', 'b'])
    expect(keepChecked(checked, new Set(['a', 'b', 'c']))).toBe(checked)
  })

  it('drops the ids that left the scope, the search or the list', () => {
    expect([...keepChecked(new Set(['a', 'b', 'gone']), new Set(['a', 'b']))]).toEqual(['a', 'b'])
  })

  it('takes a Shift-click range from the anchor, in the order the table shows', () => {
    expect(rangeOf(['a', 'b', 'c', 'd'], 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeOf(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(rangeOf(['a', 'b'], 'x', 'b')).toEqual(['b'])
  })

  it('names up to five agents in a confirm, then how many more', () => {
    const names = Array.from({ length: 7 }, (_, i) => `fixture-${i}`)
    expect(confirmNames(names)).toEqual({ names: ['fixture-0', 'fixture-1', 'fixture-2', 'fixture-3', 'fixture-4'], more: 2 })
    expect(confirmNames(names.slice(0, 3)).more).toBe(0)
  })
})

// Why a disabled action says it applies to none (S-3282): the reason a phone's tap shows in the summary line.
describe('reasonOf', () => {
  it('says why each action applies to none of the agents', () => {
    expect(reasonOf([ACTIVE, ACTIVE, ACTIVE], { kind: 'resume' })).toBe('None of the 3 can resume: all are running or archived')
    expect(reasonOf([PAUSED], { kind: 'pause' })).toBe('None of the 1 can pause: none is running')
    expect(reasonOf([ARCHIVED, ARCHIVED], { kind: 'archive' })).toBe('None of the 2 can archive: all are archived')
  })

  it('says a mode change needs a live agent, and names the mode when live agents are already in it', () => {
    expect(reasonOf([STOPPED, ARCHIVED], { kind: 'mode', mode: 'auto' })).toBe('None of the 2 can change the mode: none is live')
    expect(reasonOf([ACTIVE], { kind: 'mode', mode: 'auto' })).toBe('None of the 1 can change the mode: all are already in that mode')
  })
})
