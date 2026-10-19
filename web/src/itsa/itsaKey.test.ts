// @vitest-environment jsdom
// S-N keys in mail text: the key links to its ITSA with the ITSA's status glyph and status name.
import { beforeEach, describe, expect, it } from 'vitest'
import * as mb from '../mail/mailblocks'
import { setData } from '../store'
import type { Itsa } from '../types'
import { itsaKeyLink } from './itsa'

const itsa = (over: Partial<Itsa>): Itsa => ({ id: 'i12', key: 'S-12', title: 'Fix login', status: 'in_progress', parent_id: null, kind: null, summary: null, body: null, owner: null, thread_id: null, created_by: 'human', created_at: '', ...over } as Itsa)

beforeEach(() => {
  setData({
    itsas: [itsa({}), itsa({ id: 'i13', key: 'S-13', title: 'Ship it', status: 'done' })],
    itsaStatuses: [
      { name: 'in_progress', category: 'active', human: false },
      { name: 'done', category: 'closed', human: false },
    ],
  })
  mb.configure({ itsa: itsaKeyLink })
})

describe('ITSA keys in mail', () => {
  it('shows the status glyph and status name on a known key', () => {
    const html = itsaKeyLink('S-12')!
    expect(html).toContain('class="sglyph active"')
    expect(html).toContain('title="S-12, in progress: Fix login"')
    expect(html).toContain('aria-label="S-12, in progress: Fix login"')
    expect(html).toContain('data-open-itsa="i12"')
  })

  it('reads the current status from the store, so a change shows on the next render', () => {
    expect(itsaKeyLink('S-12')).toContain('in progress')
    setData({ itsas: [itsa({ status: 'done' }), itsa({ id: 'i13', key: 'S-13', title: 'Ship it', status: 'done' })] })
    expect(itsaKeyLink('S-12')).toContain('title="S-12, done: Fix login"')
    expect(itsaKeyLink('S-12')).toContain('class="sglyph closed"')
  })

  it('falls back to plain text for an unknown key', () => {
    expect(itsaKeyLink('S-99')).toBeNull()
    const el = document.createElement('div')
    el.innerHTML = mb.renderMail('See S-99 and S-12.')
    expect(el.querySelectorAll('a[data-open-itsa]')).toHaveLength(1)
    expect(el.textContent).toContain('S-99')
  })

  it('leaves keys in code plain', () => {
    const el = document.createElement('div')
    el.innerHTML = mb.renderMail('Use `S-12` here, and:\n\n```\nS-12\n```');
    expect(el.querySelectorAll('a[data-open-itsa]')).toHaveLength(0)
    expect(el.querySelectorAll('code').length).toBeGreaterThan(0)
    expect(el.textContent).toContain('S-12')
  })
})
