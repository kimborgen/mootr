// The Inbox page opens a thread in one pane to the list's right and reuses it (S-2054).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply, emptyLayout, type Layout, type LayoutOp } from '../../src/layout-ops.ts'
import { humanRowsOf } from './mail/thread-index'
import * as shell from './shell/layout'

let daemon: Layout = emptyLayout()
let stream: ReadableStreamDefaultController<Uint8Array>
let phone = false
// The thread requests: answered at once, or held until the test releases each one, and failed while `fail` is set.
const threadReq = { hold: false, fail: false, held: [] as { release: () => void }[], paths: [] as string[] }
const enc = new TextEncoder()
const push = (l: Layout) => stream.enqueue(enc.encode(`event: layout\ndata: ${JSON.stringify(l)}\n\n`))
const tick = () => new Promise((r) => setTimeout(r, 10))
const panes = () => shell.leaves(shell.mainWorld().root).map((l) => l.tabs)

beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    // The archive and defer requests succeed; the thread list never answers, so the store keeps what each test seeds.
    if (path.startsWith('/api/agents/human/threads/')) {
      threadReq.paths.push(path)
      const reply = () => new Response(threadReq.fail ? '{"error":"fixture: refused"}' : '{}', { status: threadReq.fail ? 500 : 200 })
      if (!threadReq.hold) return reply()
      return new Promise<Response>((resolve) => threadReq.held.push({ release: () => resolve(reply()) }))
    }
    if (path.startsWith('/api/agents/human/thread-index?') || path.startsWith('/api/agents/human/threads?')) return new Promise<Response>(() => {})
    if (path === '/api/layout/stream') return new Response(new ReadableStream<Uint8Array>({ start: (c) => { stream = c; push(daemon) } }))
    if (path === '/api/layout/ops' && init?.method === 'POST') {
      const ops = JSON.parse(String(init.body)).ops as LayoutOp[]
      daemon = { ...ops.reduce((l, op) => apply(l, op), daemon), version: daemon.version + 1 }
      queueMicrotask(() => push(daemon))
      return new Response(JSON.stringify(daemon))
    }
    return new Response('{}', { status: 404 })
  }))
  shell.init({ valid: () => true, keep: () => true, keepWorld: () => true })
  await tick()
})
afterAll(() => { vi.unstubAllGlobals() })

describe('openInboxThread', () => {
  const fresh = async () => {
    const { openWorld } = await import('./actions')
    shell.dropAgentWorld('w:inbox')
    await tick()
    shell.showAgentWorld(null)
    openWorld('inbox')
    await tick()
  }
  it('takes a thread tab that was moved into the list pane back to the right pane, never over the list', async () => {
    const { openInboxThread } = await import('./actions')
    await fresh()
    openInboxThread('m1')
    await tick()
    const list = shell.leaves(shell.mainWorld().root)[0]
    shell.move('thread:m1', 'main', list.id, null)
    await tick()
    expect(panes()).toEqual([['inbox', 'thread:m1']])
    openInboxThread('m1')
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:m1']])
    // And with the right pane open on another thread, the moved one replaces it there.
    openInboxThread('m2')
    await tick()
    shell.open('main', 'thread:m3', { pane: shell.leaves(shell.mainWorld().root)[0].id })
    await tick()
    openInboxThread('m3')
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:m3']])
  })
  it('opens a new split after the thread tab or pane was closed', async () => {
    const { openInboxThread, inboxThread } = await import('./actions')
    await fresh()
    openInboxThread('c1')
    await tick()
    shell.close('thread:c1')
    await tick()
    expect(panes()).toEqual([['inbox']])
    expect(inboxThread()).toBeNull()
    openInboxThread('c2')
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:c2']])
    // Closing the pane keeps its tab, in the list's pane; opening that thread again splits it back out.
    shell.closePane('main', shell.leaves(shell.mainWorld().root)[1].id)
    await tick()
    expect(panes()).toEqual([['inbox', 'thread:c2']])
    openInboxThread('c2')
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:c2']])
  })
  it('advances through the list as shown: the next Deferred row, and through a grouped list in its order', async () => {
    const { openInboxThread, advanceInbox } = await import('./actions')
    const { setInboxOrder } = await import('./mail/inbox-order')
    await fresh()
    // Deferred chip: two threads; the inbox's own order has neither.
    setInboxOrder(['d1', 'd2'])
    openInboxThread('d1')
    await tick()
    expect(advanceInbox('d1')).toBe(true)
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:d2']])
    // The last row goes to the one above; a list of one has nothing to open.
    setInboxOrder(['only'])
    expect(advanceInbox('only')).toBe(false)
    // A filtered, grouped list: Needs you, then Today; advancing follows that order, not the inbox's.
    setInboxOrder(['n1', 'n2', 't1', 't2'])
    openInboxThread('n2')
    await tick()
    advanceInbox('n2')
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:t1']])
  })
  it('advances in the list as it was when the thread opened, though opening it drops it (Unread marks it read)', async () => {
    const { openInboxThread, advanceInbox } = await import('./actions')
    const { setInboxOrder } = await import('./mail/inbox-order')
    await fresh()
    setInboxOrder(['a', 'c'])
    openInboxThread('a')
    await tick()
    // The page re-lists after A is read: [c] only.
    setInboxOrder(['c'])
    expect(advanceInbox('a')).toBe(true)
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:c']])
  })
  // Archive and defer both advance before the thread leaves the list (advanceFrom, then the move), so the page
  // still lists it for the first step and has re-listed by the second.
  for (const verb of ['archives', 'defers']) {
    it(`never steps back onto a thread it ${verb} when two ${verb} follow each other`, async () => {
      const { openInboxThread, advanceInbox } = await import('./actions')
      const { setInboxOrder } = await import('./mail/inbox-order')
      await fresh()
      setInboxOrder(['a', 'b'])
      openInboxThread('a')
      await tick()
      expect(advanceInbox('a')).toBe(true)
      await tick()
      expect(panes()).toEqual([['inbox'], ['thread:b']])
      setInboxOrder(['b'])
      // b is the last one left: nothing opens, a stays gone.
      expect(advanceInbox('b')).toBe(false)
    })
  }
  it('splits right of the list once, then each thread takes that pane\'s place', async () => {
    const { openInboxThread, inboxThread } = await import('./actions')
    await fresh()
    expect(shell.currentWorld()).toBe('w:inbox')
    expect(panes()).toEqual([['inbox']])
    openInboxThread('t1')
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:t1']])
    expect(inboxThread()).toBe('t1')
    openInboxThread('t2')
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:t2']])
    openInboxThread('t2')
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:t2']])
    expect(inboxThread()).toBe('t2')
  })
  it('on a phone shows the list pane first, whatever the desktop left focused', async () => {
    const { openWorld, openInboxThread } = await import('./actions')
    await fresh()
    openInboxThread('t5')
    await tick()
    const w = () => shell.mainWorld()
    expect(shell.paneActive(w().focused)).toBe('thread:t5')
    phone = true
    openWorld('inbox')
    await tick()
    expect(shell.paneActive(w().focused)).toBe('inbox')
    phone = false
  })
  it('on a phone pushes the thread as its own world', async () => {
    const { openWorld, openInboxThread } = await import('./actions')
    phone = true
    openWorld('inbox')
    await tick()
    openInboxThread('t3')
    await tick()
    expect(shell.currentWorld()).toBe('t:t3')
    phone = false
  })
  it('on a phone, Mail opens the Inbox page full width, and a thread pushes over it', async () => {
    const { openMail, openInboxThread } = await import('./actions')
    await fresh()
    phone = true
    shell.phoneShow('left')
    openMail()
    await tick()
    expect(shell.phoneShows()).toBeNull()
    expect(shell.currentWorld()).toBe('w:inbox')
    openInboxThread('t4')
    await tick()
    expect(shell.currentWorld()).toBe('t:t4')
    phone = false
  })
  it('on a phone, Main brings back the world Mail covered', async () => {
    const { openMail, leaveMail } = await import('./actions')
    await fresh()
    shell.showAgentWorld('t:t6')
    phone = true
    openMail()
    await tick()
    leaveMail()
    await tick()
    expect(shell.currentWorld()).toBe('t:t6')
    phone = false
  })
  it('on a phone, Main with no world remembered goes to the home world, not back onto the page', async () => {
    const { leaveMail } = await import('./actions')
    await fresh()
    phone = true
    leaveMail()
    await tick()
    expect(shell.currentWorld()).not.toBe('w:inbox')
    phone = false
  })
  it('on a phone, an archive under Unread advances in the list as it was when the thread opened', async () => {
    const { openMail, openInboxThread, archiveThreadAndAdvance } = await import('./actions')
    const { setInboxOrder } = await import('./mail/inbox-order')
    await fresh()
    phone = true
    openMail()
    await tick()
    // Own thread ids: an archive leaves an optimistic overlay that would show in the next test.
    setInboxOrder(['pa', 'pc', 'pe'])
    openInboxThread('pc')
    await tick()
    // Reading pc drops it from the Unread list, so the page no longer lists it.
    setInboxOrder(['pa', 'pe'])
    void archiveThreadAndAdvance('pc').catch(() => {})
    await tick()
    expect(shell.currentWorld()).toBe('t:pe')
    phone = false
  })
})

describe('Inbox page keys: step, triage, undo', () => {
  const mail = (id: string) => ({ thread_id: id, mails: [{ id: 'm-' + id, from_id: 'a1', from_name: 'fixture-dev', subject: id, created_at: new Date().toISOString(), body: 'b', recipients: [{ id: 'human', read_at: 'x' }] }] })
  const fresh = async () => {
    const { openWorld } = await import('./actions')
    shell.dropAgentWorld('w:inbox')
    await tick()
    shell.showAgentWorld(null)
    openWorld('inbox')
    await tick()
  }
  it('j and k step through the rows as shown, and stop at either end', async () => {
    const { openInboxThread, stepInbox } = await import('./actions')
    const { setInboxOrder } = await import('./mail/inbox-order')
    await fresh()
    setInboxOrder(['p', 'q', 'r'])
    openInboxThread('p')
    await tick()
    stepInbox(1)
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:q']])
    stepInbox(1)
    stepInbox(1)
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:r']])
    stepInbox(-1)
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:q']])
  })
  it('a key with no thread open starts at the first row, or the last going up', async () => {
    const { stepInbox } = await import('./actions')
    const { setInboxOrder } = await import('./mail/inbox-order')
    await fresh()
    setInboxOrder(['x', 'y'])
    stepInbox(-1)
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:y']])
  })
  it('skips a row completed elsewhere when the next one is advanced to', async () => {
    const { openInboxThread, advanceInbox } = await import('./actions')
    const { setInboxOrder } = await import('./mail/inbox-order')
    await fresh()
    setInboxOrder(['a', 'b', 'c'])
    openInboxThread('a')
    await tick()
    // b was archived in another pane after the list was shown.
    const { setData } = await import('./store')
    setData({ humanRows: humanRowsOf([mail('a'), mail('c')], [mail('b')]) } as never)
    setInboxOrder(['a', 'c'])
    expect(advanceInbox('a')).toBe(true)
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:c']])
  })
  // Each test uses its own thread ids: the optimistic overlays of one test would otherwise still show in the next.
  it('e archives the open thread and opens the next; z puts it back and opens it', async () => {
    const { openInboxThread, triageInboxThread, undoInboxTriage, inboxThread } = await import('./actions')
    const { setInboxOrder } = await import('./mail/inbox-order')
    const { getData, setData } = await import('./store')
    await fresh()
    setData({ humanRows: humanRowsOf([mail('e1'), mail('e2'), mail('e3')]) } as never)
    setInboxOrder(['e1', 'e2', 'e3'])
    // Opened from above, so the one below is the next to open.
    openInboxThread('e1')
    await tick()
    openInboxThread('e2')
    await tick()
    await triageInboxThread('e2', 'archive')
    await tick()
    expect(getData().humanRows.archived.map((t) => t.thread_id)).toEqual(['e2'])
    expect(inboxThread()).toBe('e3')
    await undoInboxTriage()
    await tick()
    expect(getData().humanRows.archived).toEqual([])
    expect(inboxThread()).toBe('e2')
  })
  it('d defers the open thread, and z undoes it; a second z does nothing', async () => {
    const { openInboxThread, triageInboxThread, undoInboxTriage, inboxThread } = await import('./actions')
    const { setInboxOrder } = await import('./mail/inbox-order')
    const { getData, setData } = await import('./store')
    await fresh()
    setData({ humanRows: humanRowsOf([mail('d1'), mail('d2')]) } as never)
    setInboxOrder(['d1', 'd2'])
    openInboxThread('d1')
    await tick()
    await triageInboxThread('d1', 'defer')
    await tick()
    expect(getData().humanRows.deferred.map((t) => t.thread_id)).toEqual(['d1'])
    expect(inboxThread()).toBe('d2')
    await undoInboxTriage()
    await tick()
    expect(getData().humanRows.deferred).toEqual([])
    expect(inboxThread()).toBe('d1')
    await undoInboxTriage()
    await tick()
    expect(getData().humanRows.deferred).toEqual([])
  })
  it('the last row advances to the one above, and a list of one leaves no pane open', async () => {
    const { openInboxThread, triageInboxThread, inboxThread } = await import('./actions')
    const { setInboxOrder } = await import('./mail/inbox-order')
    const { setData } = await import('./store')
    await fresh()
    setData({ humanRows: humanRowsOf([mail('z1'), mail('z2')]) } as never)
    setInboxOrder(['z1', 'z2'])
    openInboxThread('z2')
    await tick()
    await triageInboxThread('z2', 'archive')
    await tick()
    expect(inboxThread()).toBe('z1')
    setData({ humanRows: humanRowsOf([mail('z1')]) } as never)
    setInboxOrder(['z1'])
    openInboxThread('z1')
    await tick()
    await triageInboxThread('z1', 'archive')
    await tick()
    expect(inboxThread()).toBeNull()
  })
})

describe('Inbox page keys: the saved queue and undo under slow answers', () => {
  const mail = (id: string) => ({ thread_id: id, mails: [{ id: 'm-' + id, from_id: 'a1', from_name: 'fixture-dev', subject: id, created_at: new Date().toISOString(), body: 'b', recipients: [{ id: 'human', read_at: 'x' }] }] })
  const seed = async (ids: string[]) => {
    const { setData } = await import('./store')
    setData({ humanRows: humanRowsOf(ids.map(mail)) } as never)
    await tick()
  }
  const fresh = async () => {
    const { openWorld } = await import('./actions')
    shell.dropAgentWorld('w:inbox')
    await tick()
    shell.showAgentWorld(null)
    openWorld('inbox')
    await tick()
    threadReq.hold = false
    threadReq.fail = false
    threadReq.held = []
    threadReq.paths = []
  }
  it('keeps walking the saved queue when the visible list changes while the thread stays open', async () => {
    const { openInboxThread, advanceInbox } = await import('./actions')
    const { setInboxOrder } = await import('./mail/inbox-order')
    await fresh()
    await seed(['q1', 'q2', 'q3'])
    setInboxOrder(['q1', 'q2', 'q3'])
    openInboxThread('q1')
    await tick()
    // The chip changes to one that shows only q1; the queue taken at open still holds q2 and q3.
    setInboxOrder(['q1'])
    expect(advanceInbox('q1')).toBe(true)
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:q2']])
    // The queue survives the advance: the list now shows only q3, and q2's advance still reaches it.
    setInboxOrder(['q3'])
    expect(advanceInbox('q2')).toBe(true)
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:q3']])
  })
  it('passes over a row completed since the queue was taken, wherever it was completed', async () => {
    const { openInboxThread, advanceInbox } = await import('./actions')
    const { setInboxOrder } = await import('./mail/inbox-order')
    const { setData } = await import('./store')
    await fresh()
    await seed(['p4', 'p5', 'p6'])
    setInboxOrder(['p4', 'p5', 'p6'])
    openInboxThread('p4')
    await tick()
    setData({ humanRows: humanRowsOf([mail('p4'), mail('p6')], [mail('p5')]) } as never)
    await tick()
    expect(advanceInbox('p4')).toBe(true)
    await tick()
    expect(panes()).toEqual([['inbox'], ['thread:p6']])
  })
  it('z restores the newest triage when the answers come back in reverse order', async () => {
    const { openInboxThread, triageInboxThread, undoInboxTriage, inboxThread } = await import('./actions')
    const { setInboxOrder } = await import('./mail/inbox-order')
    const { getData } = await import('./store')
    await fresh()
    await seed(['r1', 'r2', 'r3'])
    setInboxOrder(['r1', 'r2', 'r3'])
    openInboxThread('r1')
    await tick()
    threadReq.hold = true
    const first = triageInboxThread('r1', 'archive')
    await tick()
    const second = triageInboxThread('r2', 'archive')
    await tick()
    // The later request answers first, then the earlier one.
    threadReq.held[1].release()
    await second
    threadReq.held[0].release()
    await first
    threadReq.hold = false
    expect(getData().humanRows.archived.map((t) => t.thread_id).sort()).toEqual(['r1', 'r2'])
    await undoInboxTriage()
    await tick()
    expect(getData().humanRows.archived.map((t) => t.thread_id)).toEqual(['r1'])
    expect(inboxThread()).toBe('r2')
  })
  it('z before the answer waits for the archive it undoes, then puts the thread back', async () => {
    const { triageInboxThread, undoInboxTriage, inboxThread } = await import('./actions')
    const { setInboxOrder } = await import('./mail/inbox-order')
    const { getData } = await import('./store')
    await fresh()
    await seed(['s1', 's2'])
    setInboxOrder(['s1', 's2'])
    const { openInboxThread } = await import('./actions')
    openInboxThread('s1')
    await tick()
    threadReq.hold = true
    const sent = triageInboxThread('s1', 'archive')
    const undone = undoInboxTriage()
    await tick()
    // Nothing has gone out for the undo yet, and the archive shows at once.
    expect(threadReq.paths).toEqual(['/api/agents/human/threads/s1/archive'])
    expect(getData().humanRows.archived.map((t) => t.thread_id)).toEqual(['s1'])
    threadReq.hold = false
    threadReq.held.splice(0).forEach((h) => h.release())
    await sent
    await undone
    expect(threadReq.paths.at(-1)).toBe('/api/agents/human/threads/s1/unarchive')
    expect(getData().humanRows.archived).toEqual([])
    expect(inboxThread()).toBe('s1')
  })
  it('a triage the daemon refuses leaves nothing for z to undo', async () => {
    const { openInboxThread, triageInboxThread, undoInboxTriage } = await import('./actions')
    const { setInboxOrder } = await import('./mail/inbox-order')
    await fresh()
    await seed(['f1', 'f2'])
    setInboxOrder(['f1', 'f2'])
    openInboxThread('f1')
    await tick()
    threadReq.fail = true
    await triageInboxThread('f1', 'archive')
    await tick()
    threadReq.fail = false
    await undoInboxTriage()
    expect(threadReq.paths).toEqual(['/api/agents/human/threads/f1/archive'])
  })
})
