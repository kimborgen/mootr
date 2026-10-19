// @vitest-environment jsdom
// S-1532: the declaration picker: rows that pick, the one-declaration lines with Open file, the quiet no-match note, closing.
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeclPicker, type DeclPickerProps } from './DeclPicker'
import type { DeclMatch } from './declApi'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const M = (path: string, line: number, text = `export function run() {}`): DeclMatch => ({ path, line, col: 17, kind: 'function', text })
let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = '' })
function mount(p: Partial<DeclPickerProps>) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const props: DeclPickerProps = { name: 'run', state: { s: 'loading' }, anchor: { x: 10, y: 20, top: 4 }, phone: false, onPick: vi.fn(), onClose: vi.fn(), ...p }
  act(() => root!.render(<DeclPicker {...props} />))
  return { host, props }
}

describe('DeclPicker', () => {
  it('lists matches as path:line with the line, and a row picks its match', () => {
    const ms = [M('src/a.ts', 3), M('web/b.ts', 40, 'function run(x) {')]
    const { props } = mount({ state: { s: 'list', matches: ms, total: 2 } })
    const rows = [...document.querySelectorAll('.decl-row')]
    expect(rows.map((r) => r.querySelector('.decl-row-at')?.textContent)).toEqual(['src/a.ts:3function', 'web/b.ts:40function'])
    expect(rows[1].querySelector('.decl-text')?.textContent).toBe('function run(x) {')
    act(() => { (rows[1] as HTMLElement).click() })
    expect(props.onPick).toHaveBeenCalledWith(ms[1])
    expect(document.querySelector('.decl-pop')).not.toBeNull()
    expect(document.querySelector('.decl-title')?.textContent).toBe('2 declarations of run')
  })
  it('says how many more there are past the cap', () => {
    mount({ state: { s: 'list', matches: [M('a.ts', 1), M('b.ts', 1)], total: 40 } })
    expect(document.querySelector('.decl-list')?.textContent).toContain('and 38 more')
  })
  it('one declaration outside the view: its lines from the declaration on, and Open file', () => {
    const onOpen = vi.fn()
    const m = M('lib/x.ts', 12)
    mount({ state: { s: 'one', match: m, lines: ['export function run() {', '  return 1', '}'], openNote: 'Opens the live checkout.' }, onOpen })
    expect([...document.querySelectorAll('.decl-ln')].map((e) => e.textContent)).toEqual(['12', '13', '14'])
    expect(document.querySelector('.decl-line.cur')?.textContent).toBe('12export function run() {\n')
    act(() => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open file')!.click() })
    expect(onOpen).toHaveBeenCalledWith(m)
    expect(document.body.textContent).toContain('Opens the live checkout.')
  })
  it('no match is a quiet note', () => {
    mount({ state: { s: 'none' } })
    expect(document.querySelector('.decl-note[role=status]')?.textContent).toBe('No declaration of run found.')
    expect(document.querySelector('[role=alert]')).toBeNull()
  })
  it('on the phone it is a bottom sheet over a scrim; a press and click on the scrim closes it, the click left from the opening tap does not', () => {
    const { props } = mount({ phone: true, state: { s: 'building' } })
    expect(document.querySelector('.decl-sheet')).not.toBeNull()
    expect(document.querySelector('.decl-pick')?.getAttribute('style')).toBeNull()
    const scrim = document.querySelector('.decl-scrim') as HTMLElement
    act(() => { scrim.click() })
    expect(props.onClose).not.toHaveBeenCalled()
    act(() => { scrim.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    expect(props.onClose).not.toHaveBeenCalled()
    expect(document.querySelector('.decl-scrim'), 'the scrim stays until the click, so the click cannot fall through').not.toBeNull()
    act(() => { scrim.click() })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
  it('on the phone a press outside the sheet other than the scrim does not close it', async () => {
    const { props } = mount({ phone: true, state: { s: 'none' } })
    await new Promise((r) => setTimeout(r, 5))
    act(() => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    expect(props.onClose).not.toHaveBeenCalled()
  })
  it('Escape and a press outside close it', async () => {
    const { props } = mount({ state: { s: 'none' } })
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(props.onClose).toHaveBeenCalledTimes(1)
    await new Promise((r) => setTimeout(r, 5))
    act(() => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })
})
