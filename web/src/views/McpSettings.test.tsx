// @vitest-environment jsdom
// Settings › MCP servers (S-2736): a client secret the store holds shows its name, never the object,
// a blank field keeps the reference, and a typed value is what a save sends.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpForm, type McpServer } from './McpSettings'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REF = 'mcp-fixture-login-1a2b3c4d-client'
const SERVER: McpServer = { url: 'https://login.example.com/mcp', auth: { type: 'oauth', client_id: 'fixture-client', client_secret: { secret: REF } } }

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' })))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

async function show(server: McpServer) {
  const onSave = vi.fn()
  await act(async () => { root.render(<McpForm name="fixture-login" server={server} servers={{}} onDone={() => {}} onSave={onSave} />) })
  return onSave
}
const secretInput = () => host.querySelector<HTMLInputElement>('input[aria-label="Client secret"]')
// React tracks an input's value, so the change goes through the native setter.
async function type(value: string) {
  const el = secretInput()!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function submit() {
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}

describe('McpForm client secret', () => {
  it('shows a stored reference as its name, never as an object', async () => {
    await show(SERVER)
    expect(host.textContent).not.toContain('[object Object]')
    expect(host.textContent).toContain(`Stored as ${REF}`)
    expect(secretInput()?.value).toBe('')
    expect(secretInput()?.placeholder).toBe(`Stored as ${REF}`)
  })

  it('a blank field saves the reference as it was', async () => {
    const onSave = await show(SERVER)
    await submit()
    expect(onSave.mock.calls[0][0].server.auth.client_secret).toEqual({ secret: REF })
  })

  it('a typed value is what a save sends, for the daemon to store', async () => {
    const onSave = await show(SERVER)
    await type('typed-value')
    await submit()
    expect(onSave.mock.calls[0][0].server.auth.client_secret).toBe('typed-value')
  })

  it('clearing the field of a reference keeps the reference', async () => {
    const onSave = await show(SERVER)
    await type('typed-value')
    await type('')
    await submit()
    expect(onSave.mock.calls[0][0].server.auth.client_secret).toEqual({ secret: REF })
  })
})
