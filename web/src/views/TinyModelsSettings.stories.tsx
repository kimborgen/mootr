import { TinyModelsSettings } from './TinyModelsSettings'
import { SETTINGS, TINY_MODELS } from '../stories/settingsFixtures'
import { ds, pending, reply, type Story } from '../stories/types'

const routes = { 'GET /api/tiny-models': { models: TINY_MODELS }, 'GET /api/models?kind=openrouter': { models: [{ id: 'google/gemma-3-4b-it', name: 'Gemma 3 4B', in: 0.02, out: 0.04 }] } }
const settings = (tiny: object = {}) => ({ ...SETTINGS, mail: { titles: { model: 'google/gemma-3-4b-it' } }, decisions: { model: 'microsoft/microsoft-decision-1', mailCheck: true, mailGate: false }, ...tiny })
const show = (s: object, initial: string | null, o: { disabled?: boolean } = {}) => () => <TinyModelsSettings s={s} initial={initial} disabled={o.disabled} why="Shared by all machines; change it on fixture-home." set={() => {}} />

export const stories: Story[] = [{
  name: 'Tiny models settings',
  group: 'Settings',
  what: 'Settings › Tiny models: the cheap model calls stam makes for itself. A list shows each step, whether it is on and its model; a step opens its own page with its on/off, its model, its own settings and its instructions. The tool summary, mail titles (a title prompt and a summary prompt) and instruction summaries have editable instructions with a reset to the shipped default; the decision questions are per check and live in code, so Decisions and the activity classifier show a note instead.',
  when: 'Settings, Tiny models section. The registry comes from the daemon (`GET /api/tiny-models`); values are read from the settings, so a change shows at once. On a daemon that is not the settings home, every control is disabled with the reason on hover.',
  code: ['web/src/views/TinyModelsSettings.tsx#TinyModelsSettings', 'web/src/views/TinyModelsSettings.tsx#isOn'],
  rules: [
    'Rows are the Settings rows: label and help on the left, control on the right; on a phone they stack and controls and list rows are `--size-hit-touch` tall (' + ds('Density') + ').',
    'On and off is a checkbox, never a switch (' + ds('Buttons') + '). A step with no checkbox is on while it has a model (mail titles, instruction summaries) and shows a read-only status chip. Decisions has no on/off, because its model is shared by the mail checks, decision steps, requirement checks and the activity classifier; its page lists them under Used by instead.',
    'A key the settings file lacks shows the resolved value from the daemon (the registry), so a fresh file shows the model that runs.',
    'The model is picked with the OpenRouter model picker; for steps that are off by an empty model the field reads Off. With a complete provider under Model providers, a provider select comes first and the model is saved as `provider:model`; an incomplete provider, or a `providers.openrouter` entry, is not offered, since the daemon doesn’t use it.',
    'Editable instructions save when the field is left. Text equal to the shipped default saves as empty, so a later change to the default reaches this setting. Reset to default clears the saved text and is disabled when nothing is edited. Mail titles lists two prompts, each with its own reset; an emptied prompt means the shipped default.',
    'The page remembers the open step for the browser; a closed or blocked browser store only means the list shows first.',
    'Only design-system tokens; the page adds no colour, size or duration.',
  ],
  states: [
    { name: 'List', routes, render: show(settings(), null) },
    { name: 'Tool names, on by default', routes, render: show(settings(), 'toolNames') },
    { name: 'Tool summary, shipped instructions', routes, render: show(settings(), 'toolSummary') },
    { name: 'Tool summary, on with edited instructions', routes, render: show(settings({ tiny: { toolSummary: { enabled: true, model: 'google/gemma-3-4b-it', instructions: 'Summarise one tool call as {"tool","doing"}, in Swedish.' } } }), 'toolSummary') },
    { name: 'Mail titles, shipped prompts', routes, render: show(settings(), 'mailTitles') },
    { name: 'Mail titles, edited prompts', routes, render: show(settings({ tiny: { mailTitles: { titleInstructions: 'Title this mail in two words.', summaryInstructions: 'Title and summarize the mail in Swedish. Keep the Title: and Summary: lines.' } } }), 'mailTitles') },
    { name: 'Instruction summaries, edited prompt', routes, render: show(settings({ instructions: { summaries: { model: 'google/gemma-3-4b-it' } }, tiny: { blockSummaries: { instructions: 'Summarise the block in one sentence.' } } }), 'blockSummaries') },
    { name: 'Decisions, shared model and extra settings', routes, render: show(settings(), 'decisions') },
    { name: 'Settings file without the keys', routes, render: show({}, null) },
    { name: 'Activity classifier, off', routes, render: show(settings({ activity: { classify: { enabled: false, maxUsdPerDay: 0.2 } } }), 'activityClassify') },
    { name: 'Mail titles on a configured provider', routes, render: show(settings({ providers: { 'fixture-azure': { kind: 'azure', endpoint: 'https://fixture.openai.example.com', apiVersion: 'v1' } }, mail: { titles: { model: 'fixture-azure:fixture-gpt' } } }), 'mailTitles') },
    { name: 'Shared, read-only on a peer', routes, render: show(settings(), 'toolSummary', { disabled: true }) },
    { name: 'Loading', routes: { 'GET /api/tiny-models': pending() }, render: show(settings(), null) },
    { name: 'Load fails', routes: { 'GET /api/tiny-models': reply(502, { error: 'fixture: daemon unreachable' }) }, render: show(settings(), null) },
  ],
}]
