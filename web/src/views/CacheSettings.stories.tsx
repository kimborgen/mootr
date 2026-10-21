import { CacheSettings } from './CacheSettings'
import { CACHE_AGENTS, SETTINGS, cacheAgent } from '../stories/settingsFixtures'
import { ds, pending, reply, type Story } from '../stories/types'

const show = (s: Record<string, unknown> = SETTINGS) => <div className="settings-inner"><CacheSettings s={s} /></div>
const agents = (list: unknown[], offline: string[] = [], outdated: string[] = []) => ({ 'GET /api/cache/agents': { agents: list, offline, outdated } })

// A realistic fleet: many Claude Code agents on two machines, a few on credits or spilled, and the
// Codex and OpenCode agents the table leaves out because their harness reports no cache window.
const FLEET = [
  ...Array.from({ length: 24 }, (_, i) => cacheAgent(`fixture-dev-${i + 1}`, { machine: i % 3 ? 'fixture-machine' : 'fixture-peer', ttl_at: new Date(Date.now() - (i * 7 + 1) * 60000).toISOString() })),
  cacheAgent('fixture-spilled-1', { ttl: '5m' }),
  cacheAgent('fixture-spilled-2', { ttl: '5m', machine: 'fixture-peer' }),
  cacheAgent('fixture-api-key', { ttl: '5m', account: 'fixture-claude-api', paid: true }),
  cacheAgent('fixture-a-much-longer-agent-name-for-wrapping', { ttl: null, ttl_at: null }),
  ...Array.from({ length: 8 }, (_, i) => cacheAgent(`fixture-codex-${i + 1}`, { harness: 'codex', model: 'gpt-6.1-sol', account: 'fixture-codex', ttl: null, ttl_at: null })),
  ...Array.from({ length: 6 }, (_, i) => cacheAgent(`fixture-opencode-${i + 1}`, { harness: 'opencode', model: 'openrouter/fixture/flash', account: null, ttl: null, ttl_at: null })),
]

export const stories: Story[] = [{
  name: 'Prompt caching settings',
  group: 'Settings',
  what: "Settings › Prompt caching: mootr's timers around the prompt cache (rest, the wait before a long wait rests, and idle compaction), read live from settings; the harnesses' own cache and compaction settings mootr passes on at an agent's next launch (`settings.harness`: Claude Code's cache windows, its own idle compaction and compaction window, and Codex's compaction limit), with a note that they apply at the next launch; the cache window each Claude Code agent's turns write and since when, on this machine and its peers (a peer on an older release says it doesn't report yet); and, per harness, the documented cache window on a subscription and on credits, the write and read multipliers, whether the harness compacts on its own when idle, and the sources. A subscription agent writing 5-minute caches has spilled into credits, so a warning note names it and its row takes a warning badge.",
  when: 'Settings, Prompt caching section, after Context and compaction. On the Settings page the timers and harness settings are controls (the Settings story shows them); rendered alone, as here, they are text. The agents come from `GET /api/cache/agents` (the `cache:ttl` events of the cold-wake measurement, S-2236); the facts from `CACHE_FACTS` in `web/src/cache-facts.ts`.',
  code: ['web/src/views/CacheSettings.tsx#CacheSettings', 'web/src/views/CacheSettings.tsx#spilled', 'web/src/cache-facts.ts#CACHE_FACTS', 'web/src/cache-facts.ts#cacheTimers', 'web/src/cache-facts.ts#HARNESS_SETTINGS', 'web/src/cache-facts.ts#harnessValue'],
  rules: [
    "Without Settings' controls (`edit`), values are text in the control column, never disabled inputs. With them, each timer and harness setting is a control on its settings path and saves like any other setting: a timer as minutes, a cache window or idle compaction as a segment, a compaction limit as tokens whose empty field reads Default. A timer whose feature is off stays text (Off).",
    'A harness setting left unset or cleared reads Default (Off for Claude Code\'s idle compaction, which mootr turns off); the daemon refuses a value the harness would not take, and the control goes back to what is saved.',
    'The next-launch note is a plain `.set-note` with the `rotate-ccw` icon, saying in words that a running agent keeps what it started with. On a phone the harness segments are `--size-hit-touch` tall (' + ds('Density') + ').',
    'The warning is a `.set-note.warn` with the `triangle-alert` icon and says in words what happened and why it matters; the badge repeats it in words ("5 minutes, credits"), so colour is never the only channel (' + ds('Status') + ').',
    'The agents table is a chrome table (`table.data`, `--size-row-table` rows) that scrolls in its own box, never the page; on a phone the machine and account drop under the name (' + ds('Narrow panes and overflow') + ').',
    'Harness marks take their harness hue only as a mark (' + ds('In mootr') + '). Loading is the loading mark; an unreadable route says so in words in place of the table (' + ds('Empty, loading, and error') + ').',
    'Rows stack on a phone and links in the sources are at least `--size-hit-min` tall (' + ds('Density') + ').',
  ],
  states: [
    { name: 'Default', routes: agents(CACHE_AGENTS), render: () => show() },
    { name: 'One agent spilled into credits', routes: agents([...CACHE_AGENTS, cacheAgent('fixture-spilled', { ttl: '5m' })]), render: () => show() },
    { name: 'Many agents, each harness, a peer offline, a peer outdated', routes: agents(FLEET, ['fixture-far'], ['fixture-old']), render: () => show() },
    { name: 'Rest and idle compaction off', routes: agents(CACHE_AGENTS), render: () => show({ ...SETTINGS, rest: { enabled: false, afterMinutes: 20, graceMinutes: 2 }, idleCompaction: { ...SETTINGS.idleCompaction, enabled: false } }) },
    { name: 'Harness settings set', routes: agents(CACHE_AGENTS), render: () => show({ ...SETTINGS, harness: { claude: { promptCacheTtl: '1h', subagentPromptCacheTtl: '5m', idleCompaction: true, autoCompactWindow: 400000 }, codex: { model_auto_compact_token_limit: 200000 } } }) },
    { name: 'No Claude Code agents', routes: agents([]), render: () => show() },
    { name: 'Loading', routes: { 'GET /api/cache/agents': pending() }, render: () => show() },
    { name: 'Error', routes: { 'GET /api/cache/agents': reply(503, { error: 'fixture: unreachable' }) }, render: () => show() },
  ],
}]
