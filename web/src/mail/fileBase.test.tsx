// @vitest-environment jsdom
// Where a relative file path resolves (S-1529): a mail card uses its sender's cwd, or none, and never the viewed agent's;
// a file tool's input in the conversation links to its file in the viewed agent's cwd.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileBaseCtx } from '../files/fileBase'
import { setData } from '../store'
import { ConvMailCard } from './ConvMailCard'
import { ToolCall } from './ToolGroup'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../files/open', () => ({ openFile: vi.fn() }))

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
})
let host: HTMLElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); setData({ machine: 'host1', agents: [{ id: 'sender', machine: 'storage', cwd: '/w/sender' } as never] }) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const mail = (from_id: string) => ({ id: 'm1', from_id, body: 'edit `src/a.ts:3` and /abs/b.ts', recipients: [{ id: 'viewed' }], created_at: 1 })
const paths = () => [...host.querySelectorAll<HTMLElement>('a.file-link')].map((a) => `${a.dataset.fileHost}:${a.dataset.filePath}`)

describe('a mail card in a conversation', () => {
  it('resolves a relative path in its sender\'s cwd, on the sender\'s machine', async () => {
    await act(async () => { root.render(<FileBaseCtx.Provider value={{ host: 'host1', cwd: '/w/viewed' }}><ConvMailCard m={mail('sender')} full /></FileBaseCtx.Provider>) })
    expect(paths()).toEqual(['storage:/w/sender/src/a.ts', 'storage:/abs/b.ts'])
  })
  it('leaves a relative path as text when the sender is unknown, and does not borrow the viewed agent\'s cwd', async () => {
    await act(async () => { root.render(<FileBaseCtx.Provider value={{ host: 'host1', cwd: '/w/viewed' }}><ConvMailCard m={mail('nobody')} full /></FileBaseCtx.Provider>) })
    expect(paths()).toEqual(['host1:/abs/b.ts'])
  })
})

describe('a file tool call', () => {
  const tool = (name: string, input: unknown) => <FileBaseCtx.Provider value={{ host: 'storage', cwd: '/w/viewed' }}><ToolCall name={name} input={input} status="done" watch={false} /></FileBaseCtx.Provider>
  it('links its path input, relative ones in the viewed agent\'s cwd', async () => {
    await act(async () => { root.render(tool('Read', { file_path: 'src/a.ts' })) })
    expect(paths().length).toBeGreaterThan(0)
    expect(new Set(paths())).toEqual(new Set(['storage:/w/viewed/src/a.ts']))
  })
  it('does not link other tools, and a click does not toggle the call', async () => {
    await act(async () => { root.render(tool('Bash', { command: 'src/a.ts' })) })
    expect(paths()).toEqual([])
    await act(async () => { root.render(tool('Edit', { file_path: '/abs/c.ts' })) })
    const a = host.querySelector<HTMLAnchorElement>('a.file-link')!
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { a.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(true)
  })
})
