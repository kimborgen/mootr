import { ProvidersSettings, ProviderModelPicker, type SecretInfo } from './ProvidersSettings'
import { SETTINGS } from '../stories/settingsFixtures'
import { ds, pending, reply, type Story } from '../stories/types'

const AT = '2026-10-20T09:00:00.000Z'
const secret = (name: string, o: Partial<SecretInfo> = {}): SecretInfo => ({ name, provider: name, slot: 'stam', env: null, last4: '9f3c', setAt: AT, test: null, overriddenBy: null, ...o })
const OPENROUTER = secret('openrouter', { env: 'OPENROUTER_API_KEY', test: { ok: true, at: AT, detail: 'openrouter: HTTP 200' } })
const PROVIDERS = {
  'fixture-openai': { kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', apiKey: { secret: 'fixture-openai' } },
  'fixture-azure': { kind: 'azure', endpoint: 'https://fixture.openai.example.com', apiVersion: '2024-10-21', deployment: 'fixture-gpt', apiKey: { secret: 'fixture-azure' } },
  'fixture-local': { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
  'fixture-bedrock': { kind: 'bedrock', apiKey: { env: 'FIXTURE_BEDROCK_KEY' } },
}
const SECRETS = [
  OPENROUTER,
  secret('fixture-openai', { provider: 'fixture-openai', test: { ok: false, at: AT, detail: 'fixture-openai: the provider refused the key (HTTP 401)' } }),
  secret('fixture-azure', { provider: 'fixture-azure', last4: '' }),
]
const routes = (secrets: SecretInfo[]) => ({ 'GET /api/secrets': { secrets } })
const show = (s: object, o: { disabled?: boolean } = {}) => () => <ProvidersSettings s={s} disabled={o.disabled} why="Shared by all machines; change it on fixture-home." set={() => {}} />
const pick = (value: string, ids: string[]) => () => <ProviderModelPicker ids={ids} value={value} label="Mail titles model" placeholder="Off" onChange={() => {}} />

export const stories: Story[] = [{
  name: 'Model providers settings',
  group: 'Settings',
  what: 'Settings › Model providers: where stam’s own model calls go, and their keys. OpenRouter is built in; each configured provider (OpenAI-compatible, Azure OpenAI or Bedrock) is a card with its kind, its address fields and its key. A Bedrock provider with no key signs its calls with the machine’s AWS credentials. A key field is write-only: it shows the last 4 characters at most, with Replace (Add key when there is none), Test and Delete key, and the last test result.',
  when: 'Settings, Model providers section. Provider configs are shared settings (`settings.providers`); keys come from this machine’s secret store (`GET /api/secrets`). On a daemon that is not the settings home the provider fields are disabled with the reason on hover, and the keys stay editable, since each machine keeps its own.',
  code: ['web/src/views/ProvidersSettings.tsx#ProvidersSettings', 'web/src/views/ProvidersSettings.tsx#KeyField'],
  rules: [
    'Rows are the Settings rows: label and help on the left, control on the right; on a phone they stack and the key buttons are `--size-hit-touch` tall (' + ds('Density') + ').',
    'A key is never shown: the field is a password input while it is typed and is cleared on save, and the page shows `••••` and at most the last 4 characters. Test sends the stored key to the provider and shows Works or Refused with the reason as text.',
    'One primary button per surface: Save key while a key is typed, Add provider in the add card. Remove and Delete key take danger ink on secondary geometry (' + ds('Buttons') + ').',
    'A provider missing a required field, and a secret store that can’t be read, show a warning note with the words saying what is wrong and what it means.',
    'A provider’s key is never another’s: a new id whose secret is stored already is refused, and a keyless card stores its first key under a free name; a key imported from `opencode.env` under the card’s id is not the card’s, so the card neither shows nor replaces it. A kind switch drops the old kind’s address fields.',
    'A `providers.openrouter` entry is no card: OpenRouter is built in, so the entry is shown as ignored, with Remove.',
    'Only design-system tokens; the page adds no colour, size or duration.',
  ],
  states: [
    { name: 'OpenRouter only, no key', routes: routes([]), render: show({ ...SETTINGS }) },
    { name: 'Providers with keys and test results', routes: routes(SECRETS), render: show({ ...SETTINGS, providers: PROVIDERS }) },
    { name: 'Bedrock signed with AWS credentials', routes: routes([OPENROUTER]), render: show({ ...SETTINGS, providers: { 'fixture-aws': { kind: 'bedrock', region: 'eu-west-1', profile: 'fixture' } } }) },
    { name: 'Ignored providers.openrouter entry', routes: routes([OPENROUTER]), render: show({ ...SETTINGS, providers: { openrouter: { kind: 'openai-compatible', baseUrl: 'https://fixture.example/v1', apiKey: { secret: 'fixture' } } } }) },
    { name: 'Incomplete provider', routes: routes([OPENROUTER]), render: show({ ...SETTINGS, providers: { 'fixture-new': { kind: 'azure', apiKey: { secret: 'fixture-new' } } } }) },
    { name: 'Key overridden by the environment', routes: routes([{ ...OPENROUTER, overriddenBy: 'env' }]), render: show({ ...SETTINGS }) },
    { name: 'Secret store broken', routes: { 'GET /api/secrets': reply(409, { error: 'secrets.json is not valid JSON; fix or remove it' }) }, render: show({ ...SETTINGS, providers: PROVIDERS }) },
    { name: 'Shared, read-only on a peer', routes: routes(SECRETS), render: show({ ...SETTINGS, providers: PROVIDERS }, { disabled: true }) },
    { name: 'Loading', routes: { 'GET /api/secrets': pending() }, render: show({ ...SETTINGS }) },
    { name: 'Load fails', routes: { 'GET /api/secrets': reply(502, { error: 'fixture: daemon unreachable' }) }, render: show({ ...SETTINGS }) },
  ],
}, {
  name: 'Provider and model picker',
  group: 'Settings',
  what: 'A tiny-model step’s provider and model, written as `provider:model`. With no configured provider it is the OpenRouter model picker alone; with providers it adds a provider select, and a provider other than OpenRouter takes its model (or Azure deployment) as text.',
  when: 'Settings › Tiny models, on a step’s page, in the Model row.',
  code: ['web/src/views/ProvidersSettings.tsx#ProviderModelPicker', 'web/src/views/ProvidersSettings.tsx#splitModelRef'],
  rules: [
    'A model whose prefix is no configured provider belongs to OpenRouter whole, as the daemon reads it, so OpenRouter ids with a colon keep working.',
    'Switching provider keeps the model text and writes nothing while the model is empty.',
    'The select and the field wrap on a phone; only design-system tokens.',
  ],
  states: [
    { name: 'No providers', routes: { 'GET /api/models?kind=openrouter': { models: [] } }, render: pick('google/gemma-3-4b-it', []) },
    { name: 'OpenRouter chosen', routes: { 'GET /api/models?kind=openrouter': { models: [] } }, render: pick('google/gemma-3-4b-it', ['fixture-azure']) },
    { name: 'A configured provider chosen', render: pick('fixture-azure:fixture-gpt', ['fixture-azure', 'fixture-local']) },
  ],
}]
