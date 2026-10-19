import { useState } from 'react'
import { ModelPicker, type CatalogModel } from './ModelPicker'
import { ds, pending, reply, type Story } from '../stories/types'
import { OnMount } from '../stories/helpers'

const m = (id: string, name: string, i: number | null, o: number | null): CatalogModel => ({ id, name, in: i, out: o })
const CLAUDE = [m('claude-opus-5-5', 'Opus 5.5', 15, 75), m('claude-sonnet-5-5', 'Sonnet 5.5', 3, 15), m('claude-haiku-5-5', 'Haiku 5.5', 0.8, 4)]
const CODEX = [m('gpt-6.1-sol', 'GPT 6.1 Sol', 2.5, 10), m('gpt-6.1-mini', 'GPT 6.1 Mini', 0.4, 1.6)]
const OPENCODE = [m('openrouter/fixture/flash', 'Fixture Flash', 0.1, 0.4), m('openrouter/fixture/free', 'Fixture Free', 0, 0), m('openrouter/fixture/unknown', 'Fixture Unpriced', null, null)]
const OPENROUTER = [m('fixture/flash', 'Fixture: Flash', 0.1, 0.4), m('fixture/small', 'Fixture: Small', 0.02, 0.05), m('fixture/large', 'Fixture: Large', 5, 20)]
const catalog = (h: string, models: CatalogModel[]) => ({ [`GET /api/models?kind=harness&harness=${h}`]: { models } })
const openList = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input')?.focus()
const Field = (p: { kind: 'openrouter' | 'harness'; harness?: string; value: string; placeholder?: string; disabled?: boolean }) => {
  const [v, setV] = useState(p.value)
  return <ModelPicker {...p} value={v} label="Model" onChange={setV} />
}
const open = (p: Parameters<typeof Field>[0]) => () => <OnMount run={openList}><Field {...p} /></OnMount>

export const stories: Story[] = [{
  name: 'Model picker',
  group: 'Settings',
  what: "A model field with a searchable list of the models it can take, with price where known. Typing filters by id or name, every word must match. The list sorts cheapest first by input price, or by name. Any id can be typed, including one the list lacks, and the current value stays listed and marked current. Each harness has its own catalogue, and a separate OpenRouter catalogue serves settings that call OpenRouter directly.",
  when: "A harness's model setting and the mail-titles model in the settings (`web/src/views/ConfigView.tsx`). The list loads when the field is first opened, once per catalogue for the page; a failed load is asked again on the next open.",
  code: ['web/src/views/ModelPicker.tsx#ModelPicker', 'web/src/views/ModelPicker.tsx#sortModels', 'web/src/views/ModelPicker.tsx#filterModels', 'web/src/views/ModelPicker.tsx#priceLabel'],
  rules: [
    'On a desktop the list is fixed to the field, capped at 320 px so it scrolls, and flips above the field when there is no room below. On a phone it opens as a sheet and a second search field takes the keyboard.',
    'An option is `--size-row-menu`; on a phone `--size-hit-touch` (' + ds('Density') + '). The active option, which the arrow keys move, takes the menu hover background.',
    'Typing highlights the first match, and Enter commits the highlighted option. With no match, Enter keeps the typed text as the id. Escape or leaving the field restores the saved value, so a half-typed id is never saved by accident.',
    'No animation on open or sort (' + ds('Never animated') + ').',
  ],
  states: [
    { name: 'Claude models', height: 380, routes: catalog('claude', CLAUDE), render: open({ kind: 'harness', harness: 'claude', value: 'claude-opus-5-5' }) },
    { name: 'Codex models', height: 380, routes: catalog('codex', CODEX), render: open({ kind: 'harness', harness: 'codex', value: '' , placeholder: 'Harness default' }) },
    { name: 'OpenCode models, free and unpriced', height: 380, routes: catalog('opencode', OPENCODE), render: open({ kind: 'harness', harness: 'opencode', value: 'openrouter/fixture/flash' }) },
    { name: 'OpenRouter catalogue', height: 380, routes: { 'GET /api/models?kind=openrouter': { models: OPENROUTER } }, render: open({ kind: 'openrouter', value: '', placeholder: 'Off' }) },
    { name: 'Closed', routes: catalog('claude', CLAUDE), render: () => <div className="story-pad"><Field kind="harness" harness="claude" value="claude-haiku-5-5" /></div> },
    { name: 'Disabled', render: () => <div className="story-pad"><Field kind="harness" harness="claude" value="claude-opus-5-5" disabled /></div> },
    { name: 'Loading', height: 200, routes: { 'GET /api/models?kind=harness&harness=claude': pending() }, render: open({ kind: 'harness', harness: 'claude', value: '' }) },
    { name: 'Load fails', height: 200, routes: { 'GET /api/models?kind=harness&harness=claude': reply(502, { error: 'fixture: catalogue unreachable' }) }, render: open({ kind: 'harness', harness: 'claude', value: '' }) },
  ],
}]
