import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createItsa, setItsa, topOwned, unsavedKids } from './itsa'
import { getData, getPolled, setData } from '../store'
import type { Itsa, ItsaStatus } from '../types'

const api = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({ api }))
vi.mock('../ui/menu', () => ({ toast }))

const it1 = { id: 'i1', key: 'S-1', parent_id: null, title: 'One', status: 'backlog', owner: null } as Itsa

// The daemon's side: the PATCH and POST answer when `answer` says, and GETs return the ITSAs as they are now.
let answer: (ok: boolean) => void = () => {}
beforeEach(() => {
  toast.mockClear()
  api.mockReset()
  setData({ itsas: [it1], itsaStatuses: [{ name: 'backlog', category: 'backlog', human: false }], attention: [] })
  api.mockImplementation((method: string, path: string, body?: { status?: string; title?: string }) => {
    if (method === 'GET' && path === '/api/itsas') return Promise.resolve(getPolled().itsas)
    if (method === 'GET' && path === '/api/itsas/attention') return Promise.resolve([])
    if (method === 'GET' && path === '/api/itsas/queue') return Promise.resolve([])
    return new Promise((resolve, reject) => {
      answer = (ok) => {
        if (!ok) return reject(new Error('refused for the test'))
        if (method === 'PATCH' && body?.status) setData({ itsas: [{ ...it1, status: body.status }] })
        if (method === 'POST') {
          const child = { ...it1, id: 'i2', key: 'S-2', parent_id: 'i1', title: body?.title } as Itsa
          setData({ itsas: [...getPolled().itsas, child] })
          return resolve(child)
        }
        resolve({})
      }
    })
  })
})

describe('setItsa', () => {
  it('shows the new status at once, before the daemon answers', async () => {
    const done = setItsa('i1', { status: 'ready' })
    expect(getData().itsas[0].status).toBe('ready')
    expect(getData().itsas[0].pending).toBe(true)
    answer(true)
    await expect(done).resolves.toBe(true)
  })

  it('rolls the status back and toasts when the daemon refuses', async () => {
    const done = setItsa('i1', { status: 'ready' })
    expect(getData().itsas[0].status).toBe('ready')
    answer(false)
    await expect(done).resolves.toBe(false)
    expect(getData().itsas[0].status).toBe('backlog')
    expect(getData().itsas[0].pending).toBeUndefined()
    expect(toast).toHaveBeenCalledWith("Couldn't change it: refused for the test", true)
  })
})

describe('createItsa', () => {
  it('shows the new child under its parent at once, as pending', async () => {
    const done = createItsa('i1', 'Child')
    const child = getData().itsas.find((x) => x.parent_id === 'i1')
    expect(child?.title).toBe('Child')
    expect(child?.pending).toBe(true)
    answer(true)
    await done
  })

  it('removes the pending child and toasts when the daemon refuses', async () => {
    const done = createItsa('i1', 'Child')
    answer(false)
    await expect(done).resolves.toBeNull()
    expect(getData().itsas.some((x) => x.parent_id === 'i1')).toBe(false)
    expect(toast).toHaveBeenCalledWith("Couldn't add it: refused for the test", true)
  })
})

describe('unsavedKids', () => {
  const now = Date.now()
  const pend = { id: 'pending-x', parent_id: 'i1', title: 'Child', pending: true, created_at: new Date(now).toISOString() } as Itsa
  it('keeps the pending row while the saved child is not in the fetched list', () => {
    expect(unsavedKids([pend], [])).toEqual([pend])
  })
  it('drops it once the saved child is fetched, even before the POST answers', () => {
    expect(unsavedKids([pend], [{ title: 'Child', created_at: new Date(now + 400).toISOString() }])).toEqual([])
  })
  it('keeps it beside an old child with the same title', () => {
    expect(unsavedKids([pend], [{ title: 'Child', created_at: new Date(now - 3600000).toISOString() }])).toEqual([pend])
  })
})

describe('topOwned', () => {
  const x = (id: string, parent_id: string | null, owner: string | null, status = 'in_progress'): Itsa => ({ ...it1, id, key: 'S-' + id, parent_id, owner, status })
  const statuses: ItsaStatus[] = [{ name: 'in_progress', category: 'active', human: false }, { name: 'done', category: 'closed', human: false }]
  const ids = (xs: Itsa[]) => xs.map((y) => y.id)
  beforeEach(() => setData({ itsaStatuses: statuses }))

  it('keeps only the project of an owned chain', () => {
    const all = [x('1', null, 'a'), x('2', '1', 'a'), x('3', '2', 'a')]
    expect(ids(topOwned(all, 'a'))).toEqual(['1'])
  })
  it('keeps every sibling at the same top level', () => {
    const all = [x('1', null, 'a'), x('2', null, 'a'), x('3', '2', 'a')]
    expect(ids(topOwned(all, 'a'))).toEqual(['1', '2'])
  })
  it('keeps an owned ITSA under an ancestor someone else owns', () => {
    const all = [x('1', null, 'b'), x('2', '1', 'a'), x('3', '2', 'a')]
    expect(ids(topOwned(all, 'a'))).toEqual(['2'])
  })
  it('skips a gap: an unowned middle does not hide the owned top, nor the bottom under it', () => {
    const all = [x('1', null, 'a'), x('2', '1', null), x('3', '2', 'a')]
    expect(ids(topOwned(all, 'a'))).toEqual(['1'])
  })
  it('lets a closed ancestor hide nothing, and drops closed ITSAs', () => {
    const all = [x('1', null, 'a', 'done'), x('2', '1', 'a'), x('3', null, 'a', 'done')]
    expect(ids(topOwned(all, 'a'))).toEqual(['2'])
  })
  it('shows nothing for an agent that owns none, and survives a parent loop', () => {
    expect(topOwned([x('1', null, 'b')], 'a')).toEqual([])
    expect(ids(topOwned([x('1', '2', 'a'), x('2', '1', 'a')], 'a')).length).toBe(0)
  })
})
