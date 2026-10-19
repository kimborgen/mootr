import { describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ api: vi.fn(async () => ({})), hash: new URLSearchParams() }))
const { cardFrom, cardMail, cardPlain, cardText, firstLine } = await import('./MailCard')

const mail = (m: Record<string, unknown>) => ({ id: 'm1', from_id: 'a1', body: '', recipients: [], created_at: '2026-10-15T10:00:00Z', ...m }) as never

describe('the mail card text (S-1003)', () => {
  it('takes the summary first', () => {
    expect(cardText(mail({ summary: 'Login fixed; pick a token lifetime', title: 'SSO fix', subject: 'Re: SSO' }))).toEqual({ text: 'Login fixed; pick a token lifetime' })
  })
  it('keeps the summary as Markdown, bullets included', () => {
    expect(cardText(mail({ summary: 'Pick a token lifetime (S-12):\n- 1h: safest (recommended)\n- 12h' })).text).toBe('Pick a token lifetime (S-12):\n- 1h: safest (recommended)\n- 12h')
  })
  it('falls back to the body as Markdown, cut at a line end, then the title with the subject, then the subject', () => {
    const body = '## Report\n\n```sh\nnpm test\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |'
    expect(cardText(mail({ body }))).toEqual({ text: body })
    const long = ('line of text\n').repeat(200)
    const cut = cardText(mail({ body: long })).text
    expect(cut.length).toBeLessThanOrEqual(1200)
    expect(cut.endsWith('line of text')).toBe(true)
    expect(cardText(mail({ title: 'SSO fix', subject: 'Re: `SSO` tokens' }))).toEqual({ text: 'SSO fix', more: 'SSO tokens' })
    expect(cardText(mail({ subject: 'Re: Re: deploy done' }))).toEqual({ text: 'deploy done' })
    expect(cardText(mail({}))).toEqual({ text: '(no text)' })
  })
  it('has a plain form for labels', () => {
    expect(cardPlain(mail({ body: '## Build **green**\n\n[Report](https://example.com/report)' }))).toBe('Build green\nReport')
    expect(cardPlain(mail({ summary: 'Pick:\n- 1h `ttl`\n- 12h' }))).toBe('Pick:\n1h ttl\n12h')
    expect(cardPlain(mail({ title: 'SSO fix' }))).toBe('SSO fix')
    // A body that is only a fence or a table has no prose: the title, then the subject, never the markup.
    expect(cardPlain(mail({ body: '```decision\nPick one?\n- a\n```', title: 'Pick', subject: 'Re: Pick one' }))).toBe('Pick')
    expect(cardPlain(mail({ body: '| a | b |\n|---|---|', subject: 'Re: Table mail' }))).toBe('Table mail')
    expect(cardPlain(mail({ body: '```\n' + 'x'.repeat(900) + '\n```', subject: 'S'.repeat(500) })).length).toBeLessThanOrEqual(320)
  })
  it('skips fences, tables, and callout marks in the first line', () => {
    expect(firstLine('```decision\nPick one?\n```\n> [!DONE] Shipped [PR](https://example.com/1)')).toBe('Shipped PR')
    expect(firstLine('| a | b |\n- item one\nitem two')).toBe('item one')
  })
  it('speaks for the latest mail to you, from its sender, never from you', () => {
    const toYou = [{ id: 'human', read_at: null }]
    const t = { thread_id: 't', mails: [mail({ id: 'a', from_id: 'a1', recipients: toYou }), mail({ id: 'cc', from_id: 'a2', recipients: [{ id: 'a3' }] }), mail({ id: 'b', from_id: 'human', recipients: [{ id: 'a1' }] })] }
    expect(cardMail(t as never).id).toBe('a')
    expect(cardFrom(t as never).id).toBe('a1')
  })
  it('names the other party when no mail in the thread is to you', () => {
    const t = { thread_id: 't', mails: [mail({ id: 'b', from_id: 'human', recipients: [{ id: 'a7' }] })] }
    expect(cardMail(t as never).id).toBe('b')
    expect(cardFrom(t as never).id).toBe('a7')
  })
})
