import { ConfigView } from './ConfigView'
import { OnMount } from '../stories/helpers'
import { LOCAL, openSection, pressIn, SAVE_ASKS, SAVE_REFUSED, SETTINGS, settingsRoutes } from '../stories/settingsFixtures'
import { ds, reply, type Story } from '../stories/types'
import { offerLogin } from '../local-login'

// Settings fills its pane; a frame gives it the height of a window.
const page = (run?: (el: HTMLElement) => void) => (
  <OnMount run={run ?? (() => {})}><div style={{ height: 640 }}><ConfigView /></div></OnMount>
)
const PEER = { home: 'fixture-home', local: LOCAL }

export const stories: Story[] = [{
  name: 'Settings',
  group: 'Settings',
  fit: 'page',
  what: 'The Settings page: a list of sections on the left (the assistant, new agents, agent types, tools, decision steps, requirements, work columns, mail, notifications, motion, the sidebar panes, spending, machines, MCP servers, instructions, and more) and the open section\'s forms on the right. Most settings save the moment they change and show "Saved" under the list; the text editors (instructions, messages, advanced) have a Save button. It edits `settings.json` through `PATCH /api/config/settings`, sending only the top-level keys this page changed.',
  when: 'The Settings world (`w:config`), opened with the gear button in the header (**Settings**), the Settings command in the palette, a search hit for a setting, the Usage page\'s link to the Spending section, or Edit in Settings on an agent\'s Instructions tab, which names a section and an item. On a daemon that is not the settings home, shared settings are read-only, or are sent to the home when it knows the home\'s page.',
  code: ['web/src/views/ConfigView.tsx#ConfigView', 'web/src/settings-scope.ts#scopeOf', 'web/src/settings-scope.ts#readOnly', 'web/src/settings-save.ts#buildPatch', 'web/src/settings-save.ts#savePeer'],
  rules: [
    'Permission modes (`PermissionModesSettings`, its own story) sets the mode new agents start in per harness and per agent type, through the `permissionModes` settings key, and applies a change to the running agents that follow the settings.',
    'Model providers (`ProvidersSettings`, its own story, S-2115) edits the `providers` settings key and this machine\'s provider keys through the secret routes, which never return a value; a tiny-model step then picks a provider and model under Tiny models.',
    'Prompt caching (`CacheSettings`, its own story) gets this page\'s segment and number controls, so its timers and the harness settings mootr passes on at launch (`harness.claude.*`, `harness.codex.*`) save through the same patch; a cleared harness setting is saved as null, which keeps the harness default.',
    'The Sidebar section (`SidebarSettings`, its own story) edits the desktop sidebar layout live, through the `sidebarPanes` settings record rather than the Save path of the other sections.',
    'Spending › OpenRouter budgets sets two caps on the one OpenRouter credit: Agents (`cost.accounts.openrouter.budget`) and System (`cost.accounts["openrouter-system"].budget`, created with the match `{ harness: "stam" }` on first use; the agents account, if missing, is created matching `{ harness: "opencode", model: "openrouter/" }`). Each is an amount in USD and a period (day, week, month, or until raised); empty removes the cap, and the period waits for an amount. System reserve (`cost.openrouterSystemReserveUsd`, default 1 USD) is the credit kept for stam\'s own calls when there is no system budget. Only the settings home writes them.',
    'Spending › Provider budgets shows once `providers` names a provider other than OpenRouter (S-2119): one budget row per provider, the same amount and period as above, on the account that names it (`provider`) or matches only its OpenCode models (`ID/...`), else on a new account `ID` (`ID-provider` when another account has that name) with `provider: "ID"` and the match `{ harness: "opencode", model: "ID/" }`, written under a key array so an id with a dot (`azure.eu`) stays one key. When an account already matches every OpenCode model (harness only), it bills the provider\'s agents and the daemon would refuse a second match: the row names that account and has no amount. Its help says the provider has no balance, so spend is tokens at the registry\'s prices; there is no low-credit line, which stays OpenRouter\'s.',
    'The section list is `240px` wide with `--size-row-menu` rows; the form column is at most `760px`, with `--space-8` side padding. At 760 px or narrower the list becomes a row of tabs above the form, each `--size-hit-touch` tall, and every setting row stacks its label over its control (' + ds('Density') + ').',
    'Resources sets when this machine mails a warning: CPU load per core, free RAM, swap used, and root disk used (`resourceWarn.diskPct`, default 85%; it mails once on crossing and again after the disk drops 5 points below the line and crosses it once more), plus the repeat interval and recipients.',
    'A setting saves on the control\'s own `change`: a segment, card, select, or checkbox at once, a number or text field when you leave it or press Enter. Only the top-level keys that changed are sent, so another page\'s change to a different key survives.',
    'The result shows under the section list: a check and "Saved", the daemon\'s refusal in words, or "Sent for approval (request ID)" when the caller is not the human and the daemon answered `202`. A refused key goes back to what the daemon holds, so a control never shows a value that is not saved. There is no "saving" state, and nothing clears the line: the last result stays until the next answer.',
    'On a phone the status line is hidden (the list footer is `display: none` at 760 px or narrower). A refusal shows as a notice there too: the "can\'t delete a top-level key" message, a peer\'s failed save, and this daemon\'s plain refusal (a toast, as the delete and peer errors do).',
    'Checkboxes, not toggle switches (' + ds('Checkboxes and badges') + '); buttons follow ' + ds('Buttons') + '. Disabled controls take `--text-disabled` with no hover wash; inputs, selects, and text areas also take the `--border-subtle` hairline, while segments and choice cards keep `--border-default` (' + ds('State vocabulary') + ').',
    'The list ends with Log out for a local login session (S-613), or Log in once this page was offered a local login (a `stam web` token link on 127.0.0.1 that the daemon refused as not the human, S-2121), so the login stays reachable after its bar is dismissed.',
    'An agent type\'s instructions (`type-NAME`) are the home\'s (S-417): a peer that knows the home\'s page saves them there; a peer with none shows them read-only, with Save and Reset disabled and the note "change it on HOME".',
    'On a peer, a shared setting is disabled with the title "Shared by all machines; change it on HOME." Settings tagged "This machine" stay editable. A peer that knows the home\'s page saves shared changes there first, then this machine\'s own keys here. A stale copy of the shared settings shows a warning note with its age.',
  ],
  states: [
    { name: 'Executive assistant', routes: settingsRoutes(), render: () => page() },
    // Sets the page's offered flag for the rest of this session, as a refused token link would.
    { name: 'Local login offered', routes: settingsRoutes(), render: () => (offerLogin(), page()) },
    {
      name: 'Saved',
      routes: settingsRoutes(),
      render: () => page(pressIn('Mail to you', 'Everything')),
    },
    {
      name: 'Refused',
      routes: { ...settingsRoutes(), ...SAVE_REFUSED },
      render: () => page(pressIn('Mail to you', 'Everything')),
    },
    {
      name: 'Sent for approval',
      routes: { ...settingsRoutes(), ...SAVE_ASKS },
      render: () => page(pressIn('Mail to you', 'Everything')),
    },
    { name: 'Permission modes', routes: settingsRoutes(), render: () => page(openSection('Permission modes')) },
    { name: 'Tiny models', routes: settingsRoutes(), render: () => page(openSection('Tiny models')) },
    { name: 'Spending', routes: settingsRoutes(), render: () => page(openSection('Spending')) },
    { name: 'Spending: OpenRouter budgets set', routes: settingsRoutes(undefined, { ...SETTINGS, cost: { ...SETTINGS.cost, accounts: { ...SETTINGS.cost.accounts, openrouter: { match: { harness: 'opencode', model: 'openrouter/' }, budget: { usd: 50, per: 'month' } }, 'openrouter-system': { match: { harness: 'stam' }, budget: { usd: 3, per: 'day' } } } } }), render: () => page(openSection('Spending')) },
    { name: 'Spending: provider budgets', routes: settingsRoutes(undefined, { ...SETTINGS, providers: { 'fixture-azure': { kind: 'azure', endpoint: 'https://fixture.example.com', apiVersion: 'v1' }, 'fixture-local': { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' } }, cost: { ...SETTINGS.cost, accounts: { ...SETTINGS.cost.accounts, 'fixture-azure': { match: { harness: 'opencode', model: 'fixture-azure/' }, budget: { usd: 10, per: 'month' } } } } }), render: () => page(openSection('Spending')) },
    { name: 'Spending: provider covered by a harness-only OpenCode account', routes: settingsRoutes(undefined, { ...SETTINGS, providers: { 'fixture-bedrock': { kind: 'bedrock', region: 'eu-west-1' } }, cost: { ...SETTINGS.cost, accounts: { ...SETTINGS.cost.accounts, 'fixture-opencode': { match: { harness: 'opencode' } } } } }), render: () => page(openSection('Spending')) },
    { name: 'Context and compaction', routes: settingsRoutes(), render: () => page(openSection('Context and compaction')) },
    { name: 'Prompt caching', routes: settingsRoutes(), render: () => page(openSection('Prompt caching')) },
    { name: 'Prompt caching: harness settings set', routes: settingsRoutes(undefined, { ...SETTINGS, harness: { claude: { promptCacheTtl: '1h', autoCompactWindow: 400000 }, codex: { model_auto_compact_token_limit: 200000 } } }), render: () => page(openSection('Prompt caching')) },
    { name: 'Resources (CPU, RAM, swap, disk lines)', routes: settingsRoutes(), render: () => page(openSection('Resources')) },
    { name: 'Machines (this machine only)', routes: settingsRoutes(), render: () => page(openSection('Machines')) },
    { name: 'Requirements on', routes: settingsRoutes(undefined, { ...SETTINGS, requirements: { enabled: true } }), render: () => page(openSection('Requirements')) },
    { name: 'Mail opens in the sidebar', routes: settingsRoutes(undefined, { ...SETTINGS, mailOpens: 'sidebar' }), render: () => page(openSection('Mail to you')) },
    { name: 'Advanced (JSON)', routes: settingsRoutes(), render: () => page(openSection('Advanced')) },
    {
      name: 'Shared setting on a peer',
      routes: settingsRoutes(PEER),
      render: () => page(openSection('Mail to you')),
    },
    {
      name: 'Peer that sends shared changes home',
      routes: settingsRoutes({ ...PEER, homeWeb: 'https://fixture-home.example.com' }),
      render: () => page(openSection('Mail to you')),
    },
    {
      name: 'Agent type instructions on a peer',
      routes: settingsRoutes(PEER),
      render: () => page(pressIn('Instructions', 'developer')),
    },
    {
      name: 'Peer with a stale copy',
      routes: settingsRoutes({ ...PEER, stale: true, fetchedAt: new Date(Date.now() - 3 * 3600000).toISOString() }),
      render: () => page(openSection('Mail to you')),
    },
    {
      name: 'Unreachable',
      routes: { ...settingsRoutes(), 'GET /api/config/settings': reply(503, { error: 'fixture: the daemon is unreachable' }) },
      render: () => page(),
    },
  ],
}]
