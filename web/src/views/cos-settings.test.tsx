// @vitest-environment jsdom
// Settings › Chief of staff: start and stop call /api/cos/*, a type change saves the cos type.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../types'

const calls: [string, string, unknown?][] = []
vi.mock('../api', () => ({ api: async (m: string, p: string, b?: unknown) => { calls.push([m, p, b]); return {} } }))
import { CosSettings } from './CosSettings'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const reg = { harnesses: { claude: { efforts: ['low', 'medium'] }, codex: { efforts: [] } }, models: {} }
const type = { harness: 'claude', model: null, effort: 'medium', description: '' }
const cos = { id: 'c1', name: 'cos', harness: 'claude', model: null, effort: 'medium', lifecycle: 'active', chief_of_staff: 1 } as unknown as Agent

let host: HTMLDivElement
let root: Root
beforeEach(() => { calls.length = 0; host = document.createElement('div'); document.body.append(host); root = createRoot(host); globalThis.confirm = () => true })
afterEach(() => { act(() => root.unmount()); host.remove() })
const render = (o: { cos?: Agent | null; readOnly?: boolean } = {}) =>
  act(async () => { root.render(<CosSettings cos={o.cos} type={type} reg={reg} readOnly={o.readOnly} why="Shared." onChanged={async () => {}} openInstructions={() => {}} />) })

describe('CosSettings', () => {
  it('starts one when none runs', async () => {
    await render({ cos: null })
    expect(host.querySelector('#cos-stop')).toBeNull()
    await act(async () => { host.querySelector<HTMLButtonElement>('#cos-start')!.click() })
    expect(calls[0]).toEqual(['POST', '/api/cos/start', undefined])
  })
  it('stops the running one', async () => {
    await render({ cos })
    expect(host.textContent).toContain('cos')
    await act(async () => { host.querySelector<HTMLButtonElement>('#cos-stop')!.click() })
    expect(calls[0]).toEqual(['POST', '/api/cos/stop', undefined])
  })
  it('saves the cos type when the effort changes', async () => {
    await render({ cos })
    const low = [...host.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent === 'low')!
    await act(async () => { low.click() })
    expect(calls[0]![1]).toBe('/api/types/cos')
    expect(calls[0]![2]).toMatchObject({ harness: 'claude', effort: 'low' })
  })
  it('disables the controls when read-only', async () => {
    await render({ cos, readOnly: true })
    expect(host.querySelector('fieldset.ro')?.hasAttribute('disabled')).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('#cos-stop')!.disabled).toBe(true)
  })
})
