// @vitest-environment jsdom
// Settings › Permission modes (S-2071): the selects offer what each harness lists, bypass asks first,
// and Apply shows what it switched and what it skipped.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PermissionModesSettings } from './PermissionModesSettings'
import type { HarnessMode, PermissionModes } from '../permission-modes'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const modes = (h: string, def: boolean): HarnessMode[] => [
  { mode: 'default' as const, label: 'Ask', harness: 'ask', offered: def },
  { mode: 'auto' as const, label: 'Auto', harness: 'auto rules', offered: true },
  { mode: 'bypass' as const, label: 'Bypass', harness: 'allow all', offered: true },
].map((m) => ({ ...m, harness: `${h}: ${m.harness}` }))
const INFO: PermissionModes = {
  settings: { harness: { claude: 'auto', codex: 'auto', opencode: 'auto' }, types: {} },
  harnesses: { claude: modes('claude', true), codex: modes('codex', false), opencode: modes('opencode', false) },
  types: ['developer', 'tester'],
  stale: [
    { id: 'a1', name: 'fixture-dev', harness: 'claude', type: 'developer', mode: 'auto', want: 'bypass', inPlace: true, failed: null },
    { id: 'a2', name: 'fixture-oc', harness: 'opencode', type: null, mode: 'auto', want: 'bypass', inPlace: false, failed: null },
    { id: 'a3', name: 'fixture-down', harness: 'codex', type: null, mode: 'auto', want: 'bypass', inPlace: true, failed: 'launch failed' },
  ],
}
const APPLIED = { applied: [{ name: 'fixture-dev', mode: 'bypass', result: 'restarted' }], skipped: [{ name: 'fixture-oc', reason: 'opencode keeps a session\'s permission rules' }], stale: [] }

let host: HTMLDivElement
let root: Root
let calls: { method: string; path: string }[]
let saved: unknown[]
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  calls = []; saved = []
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, path: u })
    return { ok: true, status: 200, json: async () => (method === 'POST' ? APPLIED : INFO), text: async () => JSON.stringify(method === 'POST' ? APPLIED : INFO) }
  }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

async function show(readOnly = false) {
  await act(async () => {
    root.render(<PermissionModesSettings value={undefined} types={{ developer: { harness: 'claude' }, tester: { harness: 'opencode' } }} harnesses={['claude', 'codex', 'opencode']}
      set={(n) => saved.push(n)} rev={0} readOnly={readOnly} why="Shared." />)
  })
}
const options = (sel: string) => [...host.querySelectorAll<HTMLOptionElement>(`${sel} option`)].map((o) => o.value)
const change = async (sel: string, value: string) => {
  const el = host.querySelector<HTMLSelectElement>(sel)!
  await act(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })) })
}

describe('PermissionModesSettings', () => {
  it('offers Ask for Claude only', async () => {
    await show()
    expect(options('[data-harness=claude]')).toEqual(['default', 'auto', 'bypass'])
    expect(options('[data-harness=codex]')).toEqual(['auto', 'bypass'])
    expect(options('[data-harness=opencode]')).toEqual(['auto', 'bypass'])
  })
  it('gives each type inherit plus its harness\'s modes', async () => {
    await show()
    expect(options('[data-type=developer]')).toEqual(['inherit', 'default', 'auto', 'bypass'])
    expect(options('[data-type=tester]')).toEqual(['inherit', 'auto', 'bypass'])
  })
  it('keeps a saved mode the harness no longer offers in its list', async () => {
    await act(async () => { root.render(<PermissionModesSettings value={{ harness: { codex: 'default' }, types: {} }} types={{}} harnesses={['codex']} set={() => {}} rev={0} />) })
    expect(options('[data-harness=codex]')).toEqual(['default', 'auto', 'bypass'])
    const stale = host.querySelector<HTMLOptionElement>('[data-harness=codex] option[value=default]')!
    expect(stale.disabled).toBe(true)
    expect(stale.textContent).toContain('not offered')
    expect(host.querySelector<HTMLOptionElement>('[data-harness=codex] option[value=auto]')!.disabled).toBe(false)
  })
  it('asks before bypass, saves only on yes, and warns while it is on', async () => {
    const ask = vi.fn(() => false)
    vi.stubGlobal('confirm', ask)
    await show()
    await change('[data-harness=claude]', 'bypass')
    expect(ask).toHaveBeenCalledOnce()
    expect(saved).toEqual([])
    expect(host.querySelector('[data-bypass-warning]')).toBeNull()
    ask.mockReturnValue(true)
    await change('[data-harness=claude]', 'bypass')
    expect(saved).toEqual([{ harness: { claude: 'bypass', codex: 'auto', opencode: 'auto' }, types: {} }])
  })
  it('saves a type override without asking for auto, and shows the bypass warning once set', async () => {
    await show()
    await change('[data-type=developer]', 'auto')
    expect(saved).toEqual([{ harness: INFO.settings.harness, types: { developer: 'auto' } }])
    await act(async () => { root.render(<PermissionModesSettings value={{ harness: {}, types: { developer: 'bypass' } }} types={{ developer: { harness: 'claude' } }} harnesses={['claude']} set={() => {}} rev={0} />) })
    expect(host.querySelector('[data-bypass-warning]')?.textContent).toContain('developer agents')
  })
  it('lists the stale agents with current → wanted, and why one is not switched in place or failed', async () => {
    await show()
    const row = (n: string) => host.querySelector(`[data-agent=${n}]`)!.textContent!
    expect(row('fixture-dev')).toContain('Auto → Bypass')
    expect(row('fixture-oc')).toContain('next new session')
    expect(row('fixture-down')).toContain('launch failed')
  })
  it('Apply posts, then shows what was applied and skipped', async () => {
    await show()
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.perm-stale .btn')].find((b) => b.textContent?.startsWith('Apply'))!.click() })
    expect(calls).toContainEqual({ method: 'POST', path: '/api/permission-modes/apply' })
    const r = host.querySelector('[data-apply-result]')!.textContent!
    expect(r).toContain('Switched 1 agent')
    expect(r).toContain('fixture-dev')
    expect(r).toContain('skipped 1')
    expect(r).toContain('keeps a session')
    expect(host.querySelector('[data-agent]')).toBeNull()
  })
  it('read-only disables the selects and Apply', async () => {
    await show(true)
    expect(host.querySelector<HTMLSelectElement>('[data-harness=claude]')!.disabled).toBe(true)
    expect([...host.querySelectorAll<HTMLButtonElement>('.perm-stale .btn')].every((b) => b.disabled)).toBe(true)
  })
})
