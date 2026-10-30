// @vitest-environment jsdom
// A mail row shows only the thread's topic chip; a thread with no topic keeps its subject (S-1075).
import { describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createRef } from 'react'
import { humanRowsOf } from './mail/thread-index'

vi.mock('./api', () => ({ api: vi.fn(async () => ({})), hash: new URLSearchParams() }))

const SUBJECT = '[ITSA Title Update] Issue titles needs to be shorter'
const thread = (id: string, subject: string, title: string | null) => ({ thread_id: id, mails: [{ id: 'm-' + id, from_id: 'a1', from_name: 'a1', subject, title, created_at: '2026-10-13T10:00:00Z', recipients: ['human'] }] })

describe('MailSide row title', () => {
  it('shows the topic chip alone, and the subject only when there is no topic', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const store = await import('./store')
    const { MailSide } = await import('./MailSide')
    store.setData({ humanRows: humanRowsOf([thread('t1', SUBJECT, 'ITSA Title Update'), thread('t2', 'Can u send me the mail again', null)] as never), attention: [], decisions: [], itsaStatuses: [] } as never)
    const el = document.createElement('div')
    document.body.append(el)
    await act(async () => { createRoot(el).render(<MailSide leftRef={createRef()} />) })
    const titled = el.querySelector('[data-thread="t1"]')!
    expect(titled.querySelector('.chip.mtitle')?.textContent).toBe('ITSA Title Update')
    expect(titled.querySelector('.s')).toBeNull()
    expect(titled.textContent).not.toContain('Issue titles')
    expect(titled.getAttribute('title')).toContain('Issue titles needs to be shorter')
    const untitled = el.querySelector('[data-thread="t2"]')!
    expect(untitled.querySelector('.chip.mtitle')).toBeNull()
    expect(untitled.querySelector('.s')?.textContent).toBe('Can u send me the mail again')
  })
})
