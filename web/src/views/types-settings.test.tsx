// @vitest-environment jsdom
// Settings › Agent types: the form is wrapped in a disabled fieldset only when it is read-only (S-412).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TypesSettings } from './TypesSettings'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const reg = {
  harnesses: { claude: { efforts: ['low'] } },
  models: {},
  types: { developer: { harness: 'claude', model: null, effort: null, description: 'Builds' } },
}

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

async function open(readOnly: boolean) {
  await act(async () => { root.render(<TypesSettings reg={reg} agents={[]} onChanged={async () => {}} openInstructions={() => {}} readOnly={readOnly} why="Shared." />) })
  await act(async () => { host.querySelector<HTMLButtonElement>('.type-cards .choice')!.click() })
}

describe('TypesSettings form', () => {
  it('has no fieldset and keeps Save when it is writable', async () => {
    await open(false)
    expect(host.querySelector('fieldset')).toBeNull()
    expect(host.querySelector('.ro')).toBeNull()
    expect(host.querySelector('button[type=submit]')).not.toBeNull()
  })
  it('disables every control and hides Save when it is read-only', async () => {
    await open(true)
    expect(host.querySelector('fieldset.ro')?.hasAttribute('disabled')).toBe(true)
    expect(host.querySelector('button[type=submit]')).toBeNull()
    expect(host.querySelector('.btn.danger')).toBeNull()
  })
})
