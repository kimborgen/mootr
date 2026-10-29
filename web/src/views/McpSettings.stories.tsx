import { useState } from 'react'
import { McpSettings, type Servers } from './McpSettings'
import { SETTINGS, pressEach } from '../stories/settingsFixtures'
import { OnMount } from '../stories/helpers'
import { ds, reply, type Story } from '../stories/types'

const SERVERS = SETTINGS.mcpServers as Servers
// A login whose client secret the store holds: the form shows its name, not the value (S-2736).
const OAUTH_STORED: Servers = { 'fixture-login': { url: 'https://login.example.com/mcp', auth: { type: 'oauth', client_id: 'fixture-client', client_secret: { secret: 'mcp-fixture-login-1a2b3c4d-client' } } } }
const STATUS = { 'GET /api/mcp/status': { servers: [{ name: 'fixture-docs', type: 'oauth', logged_in: true, expires_at: null }], home: null } }
// A peer: its login is the home's. `fixture-docs` is leased and logged in there; the peer keeps an old grant for `fixture-login`, which the home doesn't share.
const PEER_STATUS = { 'GET /api/mcp/status': { servers: [
  { name: 'fixture-docs', type: 'oauth', logged_in: true, expires_at: null, leased_from: 'fixture-home' },
  { name: 'fixture-login', type: 'oauth', logged_in: false, expires_at: null, local_grant: true },
], home: { name: 'fixture-home', reachable: true } } }
const PEER_DOWN_STATUS = { 'GET /api/mcp/status': { servers: [], home: { name: 'fixture-home', reachable: false, error: 'the home fixture-home is unreachable, so its MCP logins can\'t be leased; start fixture-home and retry' } } }
// Keeps the servers it is given, as ConfigView does, so a change shows.
function Host({ initial, run }: { initial: Servers; run?: (el: HTMLElement) => void }) {
  const [servers, setServers] = useState(initial)
  return <OnMount run={run ?? (() => {})}><McpSettings servers={servers} onChange={setServers} /></OnMount>
}

export const stories: Story[] = [{
  name: 'MCP servers settings',
  group: 'Settings',
  what: 'The servers every agent gets over MCP. Each row shows the server\'s name, whether it runs a local command or is a remote URL, its login and the names (never the values) of its env variables and headers, and an On box, Test, Edit, and Remove. Servers are added by pasting any harness\'s own config, importing from the harnesses already installed, or browsing the public MCP registry. A remote server that needs a login is logged in once here, and stam gives the one login to every harness.',
  when: 'Settings, MCP servers (`mcpServers`). Changes reach each agent at its next start. On a daemon that is not the settings home, MCP servers are read-only even when the home\'s page is known: the home takes them only from its own page.',
  code: ['web/src/views/McpSettings.tsx#McpSettings', 'web/src/views/McpSettings.tsx#McpForm'],
  rules: [
    'A row has `--space-3` padding above and below and a `--border-subtle` rule under it; a disabled server dims its name and details to `--text-muted`. At 760 px or narrower the row stacks: details, the On box, then the buttons, wrapping.',
    'Test shows its answer in the row: the tool count and the first six names in `--status-success-fg`, or the error in `--status-error-fg` (' + ds('Status') + ').',
    'Secrets are never shown: a row lists the names of the env variables and headers, and the preview of a paste masks each value as `••••`. An OAuth client secret the store holds shows as `Stored as NAME`; a blank field keeps it, and a typed value replaces it.',
    'A remote server defaults to the GitHub CLI login when its host is githubcopilot.com or a subdomain of it, because GitHub\'s server has no dynamic client registration and OAuth can\'t work there.',
    'Remove asks to confirm; replacing a server of the same name when adding asks too. An error from the daemon shows above the list as an alert in `--status-error-fg`.',
    'On a peer, a remote OAuth server shows `Logged in on NAME`, `Not logged in on NAME` or `Not shared by NAME` (NAME is the home\'s name) in place of the login, with no Log in button. A peer\'s own old grant shows `Remove local login`, and nothing else. When the home does not answer, the row shows `NAME unreachable` and no login state, and the reason shows once above the list.',
    'The edit form of a remote OAuth server has a Share with peers box, off by default. On a peer the box is not shown, because the home refuses that save. A server with a `leaseMaxSeconds` cap shows the cap as read-only text.',
  ],
  states: [
    { name: 'Servers', routes: STATUS, render: () => <Host initial={SERVERS} /> },
    { name: 'No servers yet', routes: STATUS, render: () => <Host initial={{}} /> },
    { name: 'Peer: login on home', routes: PEER_STATUS, render: () => <Host initial={{ ...SERVERS, ...OAUTH_STORED }} /> },
    { name: 'Peer: home unreachable', routes: PEER_DOWN_STATUS, render: () => <Host initial={{ ...SERVERS, ...OAUTH_STORED }} /> },
    { name: 'Peer: edit form', routes: PEER_STATUS, render: () => <Host initial={{ ...SERVERS, ...OAUTH_STORED }} run={(el) => { const b = [...el.querySelectorAll<HTMLElement>('[data-server=fixture-docs] button')].find((x) => x.textContent?.startsWith('Edit')); b?.click() }} /> },
    {
      name: 'Test passed',
      routes: { ...STATUS, 'POST /api/mcp/fixture-files/test': { ok: true, tools: ['read_file', 'write_file', 'list_dir', 'search', 'move', 'stat', 'delete'] } },
      render: () => <Host initial={SERVERS} run={(el) => { const b = [...el.querySelectorAll<HTMLElement>('[data-server=fixture-files] button')].find((x) => x.textContent?.startsWith('Test')); b?.click() }} />,
    },
    {
      name: 'Test failed',
      routes: { ...STATUS, 'POST /api/mcp/fixture-docs/test': reply(502, { error: 'fixture: the server did not answer in 10 s' }) },
      render: () => <Host initial={SERVERS} run={(el) => { const b = [...el.querySelectorAll<HTMLElement>('[data-server=fixture-docs] button')].find((x) => x.textContent?.startsWith('Test')); b?.click() }} />,
    },
    {
      name: 'Import from harnesses',
      routes: {
        ...STATUS,
        'GET /api/mcp/import': { servers: [
          { name: 'fixture-search', server: { url: 'https://search.example.com/mcp' }, group: 'Claude Code', file: '~/.claude.json', status: 'new' },
          { name: 'fixture-files', server: { command: 'npx', args: ['-y', 'fixture-files-mcp'] }, group: 'Claude Code', file: '~/.claude.json', status: 'differs', differences: ['args differ'] },
          { name: 'fixture-docs', server: { url: 'https://mcp.example.com/mcp' }, group: 'Codex', file: '~/.codex/config.toml', status: 'same' },
        ] },
      },
      render: () => <Host initial={SERVERS} run={pressEach('Import from harnesses')} />,
    },
    {
      name: 'New server form',
      routes: STATUS,
      render: () => <Host initial={SERVERS} run={(el) => { const b = [...el.querySelectorAll<HTMLElement>('[data-server=fixture-files] button')].find((x) => x.textContent?.startsWith('Edit')); b?.click() }} />,
    },
    {
      name: 'OAuth with a stored secret',
      routes: STATUS,
      render: () => <Host initial={OAUTH_STORED} run={(el) => { const b = [...el.querySelectorAll<HTMLElement>('[data-server=fixture-login] button')].find((x) => x.textContent?.startsWith('Edit')); b?.click() }} />,
    },
    {
      name: 'Browse the registry',
      routes: {
        ...STATUS,
        'GET /api/mcp/registry': { servers: [
          { name: 'com.example/fixture-notes', title: 'Fixture Notes', description: 'Search and write notes.', version: '1.2.0', websiteUrl: 'https://example.com/notes', repository: 'https://example.com/notes.git', options: [{ kind: 'remote', label: 'Remote', server: { url: 'https://notes.example.com/mcp' }, fields: [] }] },
          { name: 'com.example/fixture-db', title: 'Fixture Database', description: 'Read-only SQL.', version: '0.4.1', options: [{ kind: 'local', label: 'Local', server: { command: 'npx', args: ['-y', 'fixture-db-mcp'] }, fields: [{ name: 'DATABASE_URL', required: true, secret: true, in: 'env' }] }] },
        ] },
      },
      render: () => <Host initial={SERVERS} run={pressEach('Browse registry')} />,
    },
  ],
}]
