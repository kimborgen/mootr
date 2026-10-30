// The thread index (S-4577): rows built from whole threads match the daemon's indexRow (S-4520), the route is
// asked first and a 404 falls back to the old /threads route, paging included. No network: fetch is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchIndex, humanRowsOf, INDEX_RECHECK, IndexRestart, indexRow, resetIndexRoute } from './thread-index'
import { getData, humanIndex, setData } from '../store'
import type { Mail, Thread } from '../types'

const mail = (patch: Partial<Mail>): Mail => ({ id: 'm', from_id: 'a1', body: 'b', recipients: [{ id: 'human', read_at: null }], created_at: '2026-10-29T10:00:00Z', ...patch })
const thread = (id: string, mails: Mail[]): Thread => ({ thread_id: id, mails })

describe('an index row from a whole thread', () => {
  it('takes what the daemon takes from each mail', () => {
    const t = thread('t1', [
      mail({ id: 'm1', subject: 'Deploy plan', title: 'Deploy plan', itsa_id: null, recipients: [{ id: 'human', read_at: '2026-10-29T10:01:00Z' }] }),
      mail({ id: 'm2', from_id: 'human', body: 'ok', itsa_id: 'i9', recipients: [{ id: 'a1', read_at: null }], created_at: '2026-10-29T10:02:00Z' }),
      // An ask placed in the thread doesn't rename it, and its pending permission marks the row.
      mail({ id: 'm3', title: 'Approve push', permission_id: 'p1', permission: { status: 'pending' } as Mail['permission'], created_at: '2026-10-29T10:03:00Z' }),
      // A mail between two agents in the thread: the human neither sent nor got it, so it doesn't move the row.
      mail({ id: 'm4', from_id: 'a2', from_name: 'lead', kind: 'comment', body: '  two\n\nlines  ', recipients: [{ id: 'a1', read_at: null }], created_at: '2026-10-29T10:04:00Z' }),
    ])
    expect(indexRow('human', t)).toEqual({
      thread_id: 't1', subject: 'Deploy plan', title: 'Deploy plan', kind: 'comment', itsa_id: 'i9',
      from_id: 'a2', from_name: 'lead', last_at: '2026-10-29T10:03:00Z', mail_count: 4, unread: 1, ask: 'pending', snippet: 'two lines',
      // The card is the latest mail to the human (m3), not the agents' m4 after it (S-4578).
      card_from_id: 'a1', card_from_name: null, card_text: 'b', card_title: 'Approve push', card_subject: '', verdict_kind: null, about_itsa: null, itsa_chip: null,
      box_last_from: 'a1', first_created_at: '2026-10-29T10:00:00Z', last_created_at: '2026-10-29T10:04:00Z',
      // What the waits and the tab's chips read (S-4579).
      last_mail_id: 'm4', perms: [{ id: 'p1', placed: false }], itsa_links: [], about_itsas: [], agents: ['a2', 'a1'],
    })
  })

  it('reads 400 characters from the body\'s first that isn\'t blank before collapsing it, as the route\'s substr(ltrim) does', () => {
    // 400 spaces, then text: the leading blanks don't count.
    expect(indexRow('human', thread('t3', [mail({ body: ' '.repeat(400) + 'hello' })])).snippet).toBe('hello')
    // substr counts code points, not UTF-16 units: a letter, 349 spaces and 50 emoji fill the 400; the 'z' after is cut.
    expect(indexRow('human', thread('t4', [mail({ body: 'a' + ' '.repeat(349) + '😀'.repeat(60) + 'z' })])).snippet).toBe('a ' + '😀'.repeat(50))
  })

  it('speaks for the card mail: its summary over its body, cut to 300 code points with line breaks kept', () => {
    const card = (patch: Partial<Mail>) => indexRow('human', thread('c', [mail({ id: 'c1', ...patch })]))
    expect(card({ summary: '  Short.\n- one  ', body: 'long body' }).card_text).toBe('Short.\n- one')
    const long = card({ body: '\n\n' + 'line one\n' + '😀'.repeat(400) })
    expect(Array.from(long.card_text!)).toHaveLength(300)
    expect(long.card_text!.startsWith('line one\n😀')).toBe(true)
    // The ITSA it is about over the one it was sent under, and the first ITSA it names as the chip.
    const r = card({ verdict: { kind: 'done' } as Mail['verdict'], about_itsa: 'i2', itsa_id: 'i1', itsas: [{ id: 'i3', key: 'S-3', title: 'Three', status: 'todo', source: 'named' }] })
    expect(r).toMatchObject({ verdict_kind: 'done', about_itsa: 'i2', itsa_chip: { key: 'S-3', title: 'Three' } })
    expect(card({ itsa_id: 'i1' }).about_itsa).toBe('i1')
  })

  it('carries the card mail\'s own subject, a later mail\'s too', () => {
    const r = indexRow('human', thread('s', [
      mail({ id: 's1', subject: 'Deploy plan' }),
      mail({ id: 's2', subject: 'Deployment canceled', body: '', created_at: '2026-10-29T10:01:00Z' }),
    ]))
    expect(r).toMatchObject({ subject: 'Deploy plan', card_subject: 'Deployment canceled', card_text: '' })
  })

  it('lists the thread\'s permissions, its ITSA links and the people in it, as the waits and chips read them', () => {
    const itsa = (id: string, key: string) => ({ id, key, title: key + ' title', status: 'todo', source: 'itsa' as const })
    const r = indexRow('human', thread('w', [
      mail({ id: 'w1', from_id: 'a1', agents: ['a9'], itsas: [itsa('i1', 'S-1'), itsa('i2', 'S-2')], about_itsa: 'i3', recipients: [{ id: 'human', read_at: null }, { id: 'a2', read_at: null }] }),
      // An ask placed in this thread from elsewhere: its thread_id isn't its own id.
      mail({ id: 'w2', from_id: 'a3', permission_id: 'p7', kind: 'ask-link', thread_id: 'w', itsas: [itsa('i2', 'S-2')], about_itsa: 'i1', created_at: '2026-10-29T10:01:00Z' }),
      mail({ id: 'w3', from_id: 'human', recipients: [{ id: 'a1', read_at: null }], created_at: '2026-10-29T10:02:00Z' }),
    ]))
    expect(r.perms).toEqual([{ id: 'p7', placed: true }])
    expect(r.itsa_links).toEqual([
      { id: 'i1', key: 'S-1', title: 'S-1 title', status: 'todo' },
      { id: 'i2', key: 'S-2', title: 'S-2 title', status: 'todo' },
    ])
    expect(r.about_itsas).toEqual(['i3', 'i1'])
    // Attached first, then senders and recipients by their latest mail; never the box.
    expect(r.agents).toEqual(['a9', 'a3', 'a1', 'a2'])
    expect(r.last_mail_id).toBe('w3')
  })

  it('a thread of only your mail speaks for its last mail, from the last other recipient', () => {
    const r = indexRow('human', thread('h', [
      mail({ id: 'h1', from_id: 'human', body: 'first', recipients: [{ id: 'a1', read_at: null }] }),
      mail({ id: 'h2', from_id: 'human', body: 'again', recipients: [{ id: 'a2', read_at: null }], created_at: '2026-10-29T10:05:00Z' }),
    ]))
    expect(r).toMatchObject({ card_from_id: 'a2', card_from_name: null, card_text: 'again', box_last_from: 'human', from_id: 'human' })
  })

  it('the last mail the human sent or got says who spoke last to them, mail between agents aside', () => {
    const r = indexRow('human', thread('p', [
      mail({ id: 'p1', from_name: 'dev' }),
      mail({ id: 'p2', from_id: 'human', recipients: [{ id: 'a1', read_at: null }], created_at: '2026-10-29T10:01:00Z' }),
      mail({ id: 'p3', from_id: 'a1', recipients: [{ id: 'a2', read_at: null }], created_at: '2026-10-29T10:02:00Z' }),
    ]))
    expect(r).toMatchObject({ box_last_from: 'human', from_id: 'a1', card_from_id: 'a1', card_from_name: 'dev' })
  })

  it('cuts the snippet at 200 characters and leaves a thread with no pending ask unmarked', () => {
    const r = indexRow('human', thread('t2', [mail({ body: 'x'.repeat(300), permission: { status: 'approved' } as Mail['permission'] })]))
    expect(r.snippet).toHaveLength(200)
    expect(r.ask).toBeNull()
    expect(r.subject).toBe('')
    expect(r.title).toBeNull()
  })
})

describe('the human\'s index from the store', () => {
  it('reads each list\'s rows as the store holds them (S-4617)', () => {
    setData({ humanRows: humanRowsOf([thread('t1', [mail({})])], [thread('t2', [mail({ recipients: [{ id: 'human', read_at: '2026-10-29T10:05:00Z' }] })])]) })
    expect(humanIndex(getData(), 'active').map((r) => [r.thread_id, r.unread])).toEqual([['t1', 1]])
    expect(humanIndex(getData(), 'archived').map((r) => [r.thread_id, r.unread])).toEqual([['t2', 0]])
    expect(humanIndex(getData(), 'deferred')).toEqual([])
  })
})

describe('a page of the index', () => {
  let calls: string[]
  let indexStatus: number
  const old = (n: number) => Array.from({ length: n }, (_, i) => thread('o' + i, [mail({ id: 'om' + i })]))
  const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response
  beforeEach(() => {
    vi.useFakeTimers()
    resetIndexRoute()
    calls = []
    indexStatus = 200
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      if (url.includes('/thread-index')) return indexStatus === 200 ? reply(200, { threads: [], next_cursor: 'c2' }) : reply(indexStatus, { error: 'no route GET' })
      return reply(200, old(Number(/limit=(\d+)/.exec(url)![1]) > 120 ? 120 : Number(/limit=(\d+)/.exec(url)![1])))
    }))
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('asks the route with its list, limit, cursor and with', async () => {
    expect(await fetchIndex('human', 'archived', { limit: 20, cursor: 'c1', with: 'dev 1' })).toEqual({ threads: [], next_cursor: 'c2' })
    expect(calls).toEqual(['/api/agents/human/thread-index?list=archived&limit=20&cursor=c1&with=dev%201'])
  })

  it('falls back to /threads on a 404, and pages it with its own cursor', async () => {
    indexStatus = 404
    const p1 = await fetchIndex('human', 'deferred', { limit: 50 })
    expect(calls).toEqual(['/api/agents/human/thread-index?list=deferred&limit=50', '/api/agents/human/threads?limit=50&deferred=1'])
    expect(p1.threads.map((r) => r.thread_id)).toEqual(old(50).map((t) => t.thread_id))
    expect(p1.next_cursor).toBe('old:50')
    calls = []
    const p2 = await fetchIndex('human', 'deferred', { limit: 50, cursor: p1.next_cursor })
    // The route isn't asked again meanwhile; the old one is asked for both pages and the second is kept.
    expect(calls).toEqual(['/api/agents/human/threads?limit=100&deferred=1'])
    expect(p2.threads[0].thread_id).toBe('o50')
    const p3 = await fetchIndex('human', 'deferred', { limit: 50, cursor: p2.next_cursor })
    expect(p3.threads).toHaveLength(20)
    expect(p3.next_cursor).toBeNull()
  })

  it('asks the route again INDEX_RECHECK after a 404', async () => {
    indexStatus = 404
    await fetchIndex('human', 'active')
    indexStatus = 200
    calls = []
    await fetchIndex('human', 'active')
    expect(calls.some((c) => c.includes('/thread-index'))).toBe(false)
    vi.advanceTimersByTime(INDEX_RECHECK)
    calls = []
    await fetchIndex('human', 'active')
    expect(calls).toEqual(['/api/agents/human/thread-index?list=active&limit=50'])
  })

  it('asks for a fresh start when the route goes away between pages, never repeating rows', async () => {
    const p1 = await fetchIndex('human', 'active')
    expect(p1.next_cursor).toBe('c2')
    // A rollback: the route answers 404 on the next page.
    indexStatus = 404
    calls = []
    await expect(fetchIndex('human', 'active', { cursor: p1.next_cursor })).rejects.toBeInstanceOf(IndexRestart)
    // Within INDEX_RECHECK a route cursor is refused without asking anything.
    calls = []
    await expect(fetchIndex('human', 'active', { cursor: 'c2' })).rejects.toBeInstanceOf(IndexRestart)
    expect(calls).toEqual([])
    // The fresh start comes from the old route.
    const again = await fetchIndex('human', 'active')
    expect(again.next_cursor).toBe('old:50')
  })

  it('fails on any other error rather than answer from the old route', async () => {
    indexStatus = 503
    await expect(fetchIndex('human', 'active')).rejects.toMatchObject({ status: 503 })
    expect(calls).toHaveLength(1)
  })
})
