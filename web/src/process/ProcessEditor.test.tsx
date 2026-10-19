// The editor's panel (S-1083): moving from one node to another resets the Id field.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { draftFrom } from './edit'
import { DEV_CHANGE } from './fixture'
import { EditPanel, type PanelMode, type SaveState } from './ProcessEditor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const save: SaveState = { blocked: null, busy: false, error: null, saved: null, onSave: () => {}, onOpen: () => {}, onDone: () => {} }
const mount = (mode: PanelMode, over: Partial<SaveState> = {}) => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => {
    root.render(<EditPanel mode={mode} draft={draftFrom(DEV_CHANGE)} issues={[]} narrow={false} statuses={[]} types={[]} processIds={[]} diff={[{ kind: 'add', text: 'x: 1' }]} onChange={() => {}} onMode={() => {}} onAdd={() => {}} save={{ ...save, ...over }} />)
  })
  return { host, done: () => { act(() => root.unmount()); host.remove() } }
}
const type = (el: HTMLTextAreaElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})

describe('saving as a proposal', () => {
  it('needs a summary, then sends it', () => {
    const sent: string[] = []
    const { host, done } = mount({ k: 'review' }, { onSave: (s: string) => sent.push(s) })
    const btn = () => host.querySelector('[data-act=save-proposal]') as HTMLButtonElement
    expect(btn().disabled).toBe(true)
    type(host.querySelector('textarea[aria-label=Summary]') as HTMLTextAreaElement, '  Run y instead  ')
    expect(btn().disabled).toBe(false)
    act(() => btn().click())
    expect(sent).toEqual(['Run y instead'])
    done()
  })

  it('says why it is blocked, and keeps the button off', () => {
    const { host, done } = mount({ k: 'review' }, { blocked: 'Fix the problem first.' })
    type(host.querySelector('textarea[aria-label=Summary]') as HTMLTextAreaElement, 'x')
    expect((host.querySelector('[data-act=save-proposal]') as HTMLButtonElement).disabled).toBe(true)
    expect(host.textContent).toContain('Fix the problem first.')
    done()
  })

  it('shows a refusal, and names the proposal once it is made', () => {
    const a = mount({ k: 'review' }, { error: 'dev-change.yaml doesn\'t validate' })
    expect(a.host.querySelector('[role=alert]')?.textContent).toContain('doesn\'t validate')
    a.done()
    const opened: string[] = []
    const b = mount({ k: 'review' }, { saved: { key: 'S-1201', id: 'x1', pr: { number: 412, url: 'https://github.com/example/stam2/pull/412' } }, onOpen: (id: string) => opened.push(id) })
    expect(b.host.querySelector('[data-saved=S-1201]')).not.toBeNull()
    expect((b.host.querySelector('a.btn') as HTMLAnchorElement).href).toContain('/pull/412')
    act(() => (b.host.querySelector('[data-act=open-proposal]') as HTMLButtonElement).click())
    expect(opened).toEqual(['x1'])
    b.done()
  })
})

describe('the node panel', () => {
  it('shows the Id of the node it is on, not the one it was on', () => {
    const draft = draftFrom(DEV_CHANGE)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const show = (mode: PanelMode) => act(() => {
      root.render(<EditPanel mode={mode} draft={draft} issues={[]} narrow={false} statuses={[]} types={[]} processIds={[]} diff={[]} onChange={() => {}} onMode={() => {}} onAdd={() => {}} save={save} />)
    })
    show({ k: 'node', id: 'code' })
    const id = () => (host.querySelector('input[aria-label=Id]') as HTMLInputElement).value
    expect(id()).toBe('code')
    show({ k: 'node', id: 'review' })
    expect(id()).toBe('review')
    act(() => root.unmount())
    host.remove()
  })
})
