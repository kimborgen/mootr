// @vitest-environment jsdom
// The Awaiting list holds every thread whose last mail is the human's, deferred ones too (S-976).
import { describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createRef } from 'react'

vi.mock('./api', () => ({ api: vi.fn(async () => ({})), hash: new URLSearchParams() }))

const thread = (id: string, from: string) => ({ thread_id: id, mails: [{ id: 'm-' + id, from_id: from, from_name: from, subject: id, created_at: '2026-10-13T10:00:00Z', recipients: [] }] })

describe('MailSide awaiting list', () => {
  it('counts a deferred thread whose last mail is the human\'s', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const store = await import('./store')
    const { MailSide } = await import('./MailSide')
    store.setData({ humanThreads: [thread('a', 'human')], humanArchived: [thread('b', 'human')], humanDeferred: [thread('c', 'human'), thread('d', 'a1')], attention: [], decisions: [], itsaStatuses: [] } as never)
    const el = document.createElement('div')
    document.body.append(el)
    await act(async () => { createRoot(el).render(<MailSide leftRef={createRef()} />) })
    const toggle = [...el.querySelectorAll('button.mail-toggle')].find((b) => b.textContent?.startsWith('Awaiting'))
    expect(toggle?.textContent).toBe('Awaiting (3)')
  })
})
