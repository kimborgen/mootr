// @vitest-environment jsdom
// The tool calls before an agent's mail in the ITSA thread (S-1643): one ToolGroup above the mail's card, read once per mail
// from the agent's view, and nothing for mail from the human or when the read fails.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mail } from '../types'

const apiMock = vi.fn()
vi.mock('../api', () => ({ api: (...a: unknown[]) => apiMock(...a) }))
vi.mock('../files/open', () => ({ openFile: vi.fn() }))

import { MailTools, toolsOfMail } from './MailTools'
import { ThreadItems } from '../views/ItsaView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mail = (id: string, from_id: string, extra: Partial<Mail> = {}): Mail => ({
  id, from_id, body: id, recipients: [{ id: 'human', read_at: null }], created_at: '2026-10-18T10:00:20Z', kind: 'comment', thread_id: 'th-tools', ...extra,
})
const TOOLS = {
  tools: [
    { id: 't1', name: 'Bash', input: { command: 'npm test' }, output: 'ok', status: 'done' },
    { id: 't2', name: 'Read', input: { file_path: 'src/a.ts' }, output: 'file', status: 'done' },
  ],
}

// jsdom has no layout: the thread's charts observe their size, and its mail follows the colour scheme.
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
})

let host: HTMLElement
let root: Root
beforeEach(() => {
  apiMock.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

describe('the tool calls before a mail', () => {
  it('draws one drawer above the card with the calls, read from the sender\'s view', async () => {
    apiMock.mockResolvedValue(TOOLS)
    await act(async () => { root.render(<MailTools mail={mail('m1', 'a1')} />) })
    await flush()
    expect(apiMock).toHaveBeenCalledWith('GET', '/api/agents/a1/view/tools?mail=m1')
    expect(host.querySelector('details.ov-tools .ov-tools-n')?.textContent).toBe('2 tool calls')
    expect(host.querySelectorAll('.ov-tools-rows .ov-tool').length).toBe(2)
  })

  it('draws nothing when the sender made no calls, or its view is gone', async () => {
    apiMock.mockResolvedValueOnce({ tools: [] })
    await act(async () => { root.render(<MailTools mail={mail('m2', 'a1')} />) })
    await flush()
    expect(host.querySelector('details.ov-tools')).toBeNull()
    apiMock.mockRejectedValueOnce(new Error('its transcript is gone'))
    await act(async () => { root.render(<MailTools mail={mail('m3', 'a1')} />) })
    await flush()
    expect(host.querySelector('details.ov-tools')).toBeNull()
    expect(host.textContent).not.toContain('transcript is gone')
  })

  it('reads each mail once, and keeps the answer for the page\'s life', async () => {
    apiMock.mockResolvedValue(TOOLS)
    const first = toolsOfMail('a1', 'm4')
    const again = toolsOfMail('a1', 'm4')
    expect(again).toBe(first)
    expect((await first).tools.map((t) => t.result)).toEqual(['ok', 'file'])
    expect(apiMock).toHaveBeenCalledTimes(1)
  })

  it('is drawn in the ITSA thread before an agent\'s mail, and not before mail from the human', async () => {
    apiMock.mockImplementation((_m: string, path: string) => Promise.resolve(path.includes('/view/tools') ? TOOLS : {}))
    await act(async () => {
      root.render(<ThreadItems items={[
        { type: 'mail', ts: '2026-10-18T10:00:20Z', mail: mail('m5', 'a1') },
        { type: 'mail', ts: '2026-10-18T10:01:00Z', mail: mail('m6', 'human', { recipients: [{ id: 'a1', read_at: null }] }) },
      ]} />)
    })
    await flush()
    const turns = host.querySelectorAll('.ov-turn-root')
    expect(turns[0].firstElementChild!.querySelector('details.ov-tools')).not.toBeNull() // above the card
    expect(turns[0].querySelector('section.ov-turn')).not.toBeNull()
    expect(turns[1].querySelector('details.ov-tools')).toBeNull()
    expect(apiMock.mock.calls.map((c) => c[1])).toEqual(['/api/agents/a1/view/tools?mail=m5'])
  })
  it('keeps a refusal (no view, no such mail) as an empty answer, so it is not asked again', async () => {
    apiMock.mockRejectedValueOnce(Object.assign(new Error('its transcript is gone'), { status: 409 }))
    const first = toolsOfMail('a1', 'm7')
    expect((await first).tools).toEqual([])
    expect(await toolsOfMail('a1', 'm7')).toBe(await first)
    expect(apiMock).toHaveBeenCalledTimes(1)
  })
  it('drops a failed read, so the next view of the card reads again', async () => {
    apiMock.mockRejectedValueOnce(Object.assign(new Error('Failed to fetch'), { status: 0 }))
    expect((await toolsOfMail('a1', 'm8')).tools).toEqual([])
    apiMock.mockResolvedValueOnce(TOOLS)
    expect((await toolsOfMail('a1', 'm8')).tools.length).toBe(2)
    expect(apiMock).toHaveBeenCalledTimes(2)
  })
  it('says so when the earlier calls were not read', async () => {
    apiMock.mockResolvedValueOnce({ ...TOOLS, truncated: true })
    await act(async () => { root.render(<MailTools mail={mail('m9', 'a1')} />) })
    await flush()
    expect(host.querySelector('details.ov-tools')).not.toBeNull()
    expect(host.querySelector('p.muted')?.textContent).toBe('Earlier calls not shown')
  })
})
