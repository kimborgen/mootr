// @vitest-environment jsdom
// Settings › Model providers (S-2115): a key is written, tested and deleted through the secret routes and
// never shown; a broken store says so and blocks key changes; providers are added and removed through the
// settings setter; a tiny-model step's provider and model are read and written as `provider:model`.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProvidersSettings, ProviderModelPicker, splitModelRef, joinModelRef, usableProviders, type SecretInfo } from './ProvidersSettings'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'sk-typed-by-the-human-1234'
const AT = '2026-10-20T09:00:00.000Z'
const OR: SecretInfo = { name: 'openrouter', provider: 'openrouter', slot: 'stam', env: 'OPENROUTER_API_KEY', last4: '9f3c', setAt: AT, test: null, overriddenBy: null }

let host: HTMLDivElement
let root: Root
let calls: { method: string; path: string; body?: unknown }[]
let secrets: SecretInfo[] | 'broken'
let saved: [string, unknown][]
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  calls = []; saved = []; secrets = [OR]
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, path: u, ...(init?.body ? { body: JSON.parse(init.body) } : {}) })
    let status = 200
    let body: unknown = {}
    if (method === 'GET') {
      if (secrets === 'broken') { status = 409; body = { error: 'secrets.json is not valid JSON; fix or remove it' } } else body = { secrets }
    } else if (method === 'POST') body = { provider: 'openrouter', ok: false, status: 401, detail: 'the provider refused the key (HTTP 401)' }
    else if (method === 'PUT') body = { ...OR, last4: '1234' }
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }
  }))
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const s = (providers: object = {}) => ({ providers })
async function show(settings: object = s(), disabled = false) {
  await act(async () => { root.render(<ProvidersSettings s={settings} disabled={disabled} why="Shared." set={(p, v) => saved.push([p, v])} />) })
}
const button = (text: string, within: ParentNode = host) => [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!
const click = async (el: HTMLElement) => { await act(async () => { el.click() }) }
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ProvidersSettings', () => {
  it('shows a stored key as its last 4 only, and Replace writes a typed key that is then cleared', async () => {
    await show()
    expect(host.textContent).toContain('9f3c')
    await click(button('Replace'))
    const input = host.querySelector<HTMLInputElement>('input[type=password]')!
    expect(input.autocomplete).toBe('new-password')
    await type(input, KEY)
    await act(async () => { input.form!.requestSubmit() })
    expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/api/secrets/openrouter', body: { value: KEY, provider: 'openrouter', env: 'OPENROUTER_API_KEY' } })
    expect(host.querySelector('input[type=password]')).toBeNull()
    expect(host.innerHTML).not.toContain(KEY)
  })

  it('Test asks the daemon and shows the answer as text', async () => {
    await show()
    await click(button('Test'))
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/secrets/openrouter/test', body: { provider: 'openrouter' } })
    expect(host.textContent).toContain('Refused')
    expect(host.textContent).toContain('the provider refused the key (HTTP 401)')
  })

  it('a broken store says what it means and blocks key changes', async () => {
    secrets = 'broken'
    await show()
    expect(host.querySelector('.set-note.warn')?.textContent).toContain('a key you deleted can be in use again')
    expect(button('Add key').disabled).toBe(true)
  })

  it('adds a provider named by a valid id, naming its key as a secret, and refuses a taken or bad id', async () => {
    await show(s({ mine: { kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: { secret: 'mine' } } }))
    const id = host.querySelector<HTMLInputElement>('input[aria-label="New provider id"]')!
    await type(id, 'Bad Id')
    expect(button('Add provider').disabled).toBe(true)
    await type(id, 'mine')
    expect(host.textContent).toContain('There is a provider mine already.')
    await type(id, 'myazure')
    await click(button('Azure OpenAI', host.querySelector('.prov-add')!))
    await act(async () => { id.form!.requestSubmit() })
    expect(saved).toEqual([['providers.myazure', { kind: 'azure', apiKey: { secret: 'myazure' } }]])
  })

  it('a Bedrock provider is added with no key, signed with AWS credentials until a key is added', async () => {
    await show(s({ br: { kind: 'bedrock', region: 'us-east-1' } }))
    expect(host.querySelector('[aria-label="Provider br"]')!.textContent).toContain('signed with this machine’s AWS credentials')
    expect(host.querySelector('input[aria-label="br AWS profile"]')).not.toBeNull()
    const id = host.querySelector<HTMLInputElement>('input[aria-label="New provider id"]')!
    await type(id, 'mybr')
    await click(button('Bedrock', host.querySelector('.prov-add')!))
    await act(async () => { id.form!.requestSubmit() })
    expect(saved).toEqual([['providers.mybr', { kind: 'bedrock' }]])
  })

  it('the first key on a keyless Bedrock card is saved, then named in its config', async () => {
    await show(s({ br: { kind: 'bedrock', region: 'us-east-1' } }))
    await click(button('Add key', host.querySelector('[aria-label="Provider br"]')!))
    const input = host.querySelector<HTMLInputElement>('input[type=password]')!
    await type(input, KEY)
    await act(async () => { input.form!.requestSubmit() })
    expect(calls.find((c) => c.method === 'PUT')?.path).toBe('/api/secrets/br')
    expect(saved).toEqual([['providers.br.apiKey', { secret: 'br' }]])
  })

  it('a key stored for a provider whose config doesn\'t name it yet is linked on Replace', async () => {
    secrets = [OR, { ...OR, name: 'br', provider: 'br', env: null }]
    await show(s({ br: { kind: 'bedrock', region: 'us-east-1' } }))
    await click(button('Replace', host.querySelector('[aria-label="Provider br"]')!))
    const input = host.querySelector<HTMLInputElement>('input[type=password]')!
    await type(input, KEY)
    await act(async () => { input.form!.requestSubmit() })
    expect(calls.find((c) => c.method === 'PUT')?.path).toBe('/api/secrets/br')
    expect(saved).toEqual([['providers.br.apiKey', { secret: 'br' }]])
  })

  it('never binds a provider to a key stored for another use', async () => {
    // As importLegacyOnce writes them: under the provider's own name, with the variable and slot.
    const imported: SecretInfo = { ...OR, name: 'anthropic', provider: 'anthropic', slot: 'stam', env: 'ANTHROPIC_API_KEY' }
    const agent: SecretInfo = { ...imported, name: 'anthropic-agent', slot: 'agent' }
    secrets = [OR, imported, agent, { ...OR, name: 'openrouter-agent', slot: 'agent' }]
    await show(s({ anthropic: { kind: 'bedrock', region: 'us-east-1' } }))
    // A keyless card whose id names an imported secret neither shows nor stores over it: its key goes
    // under the next free name.
    const card = host.querySelector('[aria-label="Provider anthropic"]')!
    expect(card.textContent).not.toContain('9f3c')
    expect(card.textContent).not.toContain('Replace')
    await click(button('Add key', card))
    const input = host.querySelector<HTMLInputElement>('input[type=password]')!
    await type(input, KEY)
    await act(async () => { input.form!.requestSubmit() })
    expect(calls.find((c) => c.method === 'PUT')?.path).toBe('/api/secrets/anthropic-2')
    expect(saved).toEqual([['providers.anthropic.apiKey', { secret: 'anthropic-2' }]])
    // A new provider can't take an id whose key is stored already.
    const id = host.querySelector<HTMLInputElement>('input[aria-label="New provider id"]')!
    await type(id, 'openrouter-agent')
    expect(host.textContent).toContain('A key named openrouter-agent is stored already')
    expect(button('Add provider').disabled).toBe(true)
  })

  it('a kind switch drops the old kind’s address fields and keeps the key', async () => {
    await show(s({ a: { kind: 'azure', endpoint: 'https://res.openai.azure.com', apiVersion: 'v1', deployment: 'd', apiKey: { secret: 'a' } } }))
    await click(button('Bedrock', host.querySelector('[aria-label="Provider a"]')!))
    expect(saved).toEqual([['providers.a', { kind: 'bedrock', apiKey: { secret: 'a' } }]])
  })

  it('a providers.openrouter entry is shown as ignored, not as a card, and can be removed', async () => {
    await show(s({ openrouter: { kind: 'openai-compatible', baseUrl: 'https://evil.example/v1', apiKey: { secret: 'k' } } }))
    expect(host.querySelectorAll('[aria-label="Provider openrouter"]').length).toBe(1)
    expect(host.textContent).toContain('It is ignored')
    await click(button('Remove'))
    expect(saved).toEqual([['providers', {}]])
  })

  it('names what an incomplete provider lacks, and Remove drops it alone', async () => {
    await show(s({ a: { kind: 'azure', apiKey: { secret: 'a' } }, b: { kind: 'openai-compatible', baseUrl: 'https://b.example/v1' } }))
    const a = host.querySelector('[aria-label="Provider a"]')!
    expect(a.textContent).toContain('Not used until it has Endpoint and API version.')
    await click(button('Remove', a))
    expect(saved).toEqual([['providers', { b: { kind: 'openai-compatible', baseUrl: 'https://b.example/v1' } }]])
  })

  it('read-only on a peer: provider fields are disabled, keys are not', async () => {
    await show(s({ a: { kind: 'openai-compatible', baseUrl: 'https://a.example/v1', apiKey: { secret: 'a' } } }), true)
    expect(button('Remove').disabled).toBe(true)
    expect(host.querySelector<HTMLInputElement>('input[aria-label="a Base URL"]')!.disabled).toBe(true)
    expect(button('Add key', host.querySelector('[aria-label="Provider a"]')!).disabled).toBe(false)
  })
})

describe('provider:model', () => {
  it('a step can name only complete providers, never a providers.openrouter entry', () => {
    expect(usableProviders({
      openrouter: { kind: 'openai-compatible', baseUrl: 'https://x/v1' },
      half: { kind: 'azure', endpoint: 'https://r.openai.azure.com' },
      odd: { kind: 'vertex' },
      ok: { kind: 'openai-compatible', baseUrl: 'https://x/v1' },
      br: { kind: 'bedrock', region: 'eu-west-1' },
    })).toEqual(['br', 'ok'])
  })

  it('splits only on a configured provider id, as the daemon does', () => {
    expect(splitModelRef('myazure:gpt-4o', ['myazure'])).toEqual({ provider: 'myazure', model: 'gpt-4o' })
    expect(splitModelRef('meta-llama/llama-3:free', ['myazure'])).toEqual({ provider: 'openrouter', model: 'meta-llama/llama-3:free' })
    expect(joinModelRef('openrouter', 'google/gemma')).toBe('google/gemma')
    expect(joinModelRef('myazure', 'gpt-4o')).toBe('myazure:gpt-4o')
    expect(joinModelRef('myazure', '')).toBe('')
  })

  it('switching provider keeps the model and writes provider:model', async () => {
    const out: string[] = []
    await act(async () => { root.render(<ProviderModelPicker ids={['myazure']} value="gpt-4o-mini" label="Step model" onChange={(v) => out.push(v)} />) })
    const sel = host.querySelector<HTMLSelectElement>('select')!
    expect(sel.value).toBe('openrouter')
    await act(async () => { sel.value = 'myazure'; sel.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(out).toEqual(['myazure:gpt-4o-mini'])
  })

  it('with no configured provider it is the OpenRouter picker alone', async () => {
    await act(async () => { root.render(<ProviderModelPicker ids={[]} value="google/gemma" label="Step model" onChange={() => {}} />) })
    expect(host.querySelector('select')).toBeNull()
  })
})
