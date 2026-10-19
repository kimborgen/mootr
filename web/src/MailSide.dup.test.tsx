// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createRef } from 'react'

vi.mock('./api', () => ({ api: vi.fn(async () => ({})), hash: new URLSearchParams() }))

describe('To answer with a deferred permission thread', () => {
  it('lists the request once', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const store = await import('./store')
    const { MailSide } = await import('./MailSide')
    const pt = { thread_id: 'tp', mails: [{ id: 'm-p', from_id: 'a2', from_name: 'bob', subject: 'perm', created_at: '2026-10-13T10:00:00Z', recipients: [{ id: 'human' }], permission_id: 'p1', permission: { status: 'pending' } }] }
    const perm = { id: 'p1', agent_id: 'a2', status: 'pending', created_at: '2026-10-13T10:00:00Z', action: 'run x' }
    store.setData({ humanThreads: [], humanArchived: [], humanDeferred: [pt], attention: [], decisions: [], perms: [perm], agents: [], delegateDialogs: [], itsaStatuses: [] } as never)
    const el = document.createElement('div')
    document.body.append(el)
    await act(async () => { createRoot(el).render(<MailSide leftRef={createRef()} />) })
    const btn = el.querySelector<HTMLButtonElement>('[data-to-answer]')!
    await act(async () => { btn.click() })
    const rows = [...el.querySelectorAll('.mail-side-list .mrow')].map((r) => r.textContent)
    expect(rows.length).toBe(1)
  })
})
