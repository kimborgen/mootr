import { itsa, itsaData, STATUSES, TREE } from '../../stories/itsaFixtures'
import { ds, reply, sse, type Story } from '../../stories/types'
import type { Itsa } from '../../types'
import { DEFAULT_STATE, setUsageState, type UsagePeriod, type UsageScope } from '../state'
import { SCOPE_AGENTS, scopeAnswer, scopeRoute } from '../story-data'
import { ScopedView, StatusBadge } from './Drill'

const ITSA = TREE.find((x) => x.key === 'S-911')!
// An ITSA opened long enough ago that the samples kept no longer reach the start of its life.
const OLD = itsa(980, null, 'Fixture migration cleanup', 'done', { owner: 'fx-dev', min: 60_000 })
const AGENT = SCOPE_AGENTS[1]

// The span the scope is asked for: from the ITSA's own open time, hourly under 48 hours, else daily
// (./math.ts#itsaSpan). Built here the way ./useScope.ts builds the query, so the stub key matches.
const span = (x: Itsa) => {
  const since = new Date(Date.parse(x.created_at)).toISOString()
  return { since, bucket: Date.now() - Date.parse(since) < 48 * 3_600_000 ? 'hour' as const : 'day' as const }
}
const scopeOf = (kind: UsageScope['kind'], id: string): UsageScope => ({ kind, id })
const name = (x: Itsa) => `${x.key} ${x.title}`

// Each state drills into one scope: the page's own state says which one (that is what a chart or a
// table click sets), and the scope prop is what ScopedView asks the daemon for.
const drilled = (scope: UsageScope, days: UsagePeriod = 7) => () => setUsageState({ ...DEFAULT_STATE, days, scope })
const view = (scope: UsageScope) => () => <div className="pad usage"><ScopedView scope={scope} /></div>

const TREE_SCOPE = scopeOf('tree', 'fx-t1')
const ITSA_SCOPE = scopeOf('itsa', ITSA.key)
const OLD_SCOPE = scopeOf('itsa', OLD.key)
const AGENT_SCOPE = scopeOf('agent', AGENT.id)
const MODEL_SCOPE = scopeOf('model', 'claude · claude-opus-5-5')
const HARNESS_SCOPE = scopeOf('harness', 'claude')

export const stories: Story[] = [{
  name: 'Usage drill-down',
  group: 'Settings',
  what: 'The scoped Overview: what a click on a tree, ITSA, model, harness or agent shows in place of the page\'s tiles, charts and tables. Breadcrumbs lead back up (an ITSA\'s crumb carries its tree, its title and its status badge), four tiles give the cost so far, the scope\'s share of a subscription window, its tokens or — for an ITSA — the typical cost of a closed issue of its configuration, and the agents in it; below them are spend per hour or per day stacked by agent, the spend by model as ranked bars, the agents table, and, for an ITSA, its child ITSAs.',
  when: 'The Overview tab of the Usage page (`usage` world) while a drill scope is set (`web/src/usage/state.ts`): a bar, a legend entry or a table row in the Overview or in this view sets it, the All crumb clears it, and Back and Forward walk the drill. Each scope is one call to GET /api/usage/scope (web/src/usage/drill/useScope.ts).',
  code: [
    'web/src/usage/drill/Drill.tsx#ScopedView',
    'web/src/usage/drill/Drill.tsx#StatusBadge',
    'web/src/usage/drill/useScope.ts#useScope',
  ],
  rules: [
    'The crumbs are `--type-chrome-sm`, wrap on a phone, name the crumb in `--accent-text` with `--text-muted` separators, and each crumb is `--size-row-menu` tall (`--size-hit-touch` at 760 px and narrower) (' + ds('Density') + ')',
    'An ITSA\'s status is a badge in its own tone: done `ok`, a human or blocked status `warn`, active and review `progress`, anything else untoned (' + ds('State vocabulary') + ')',
    'The tiles are the page\'s `.mb-metric` apparatus in four columns (two on a phone). A typical cost more than 1.5× the median issue takes warning ink and reads "N× the median issue"',
    'The chart is the Overview\'s stacked columns over hours or days (today asks the daemon for hours), each agent keeping its colour slot across a filter or a period; the legend and a bar click drill into that agent or model, and Other and the dead entries are disabled',
    'By model is a ranked bar list in the harness hues: `--h-claude`, `--h-codex`, `--h-opencode`, and `--text-muted` for spend that belongs to no harness; each row names its share of the scope',
    'An agent row is a click target: it hovers in `--control-hover-bg`, takes the `--focus-ring`, and drills into that agent. At 760 px and narrower the token columns fold into one muted line under the row, and a table wider than its pane scrolls sideways inside it (' + ds('Narrow panes and overflow') + ')',
    'A child ITSA row names its key (a link in `--cite-ink` when the store holds it), its title, its owner and status, and its cost; a click elsewhere on the row drills into the child',
    'Before the scope answers the view shows the loading mark (`Loading`); a 404 says "Not found" and a 403 "Not visible to you", both without a Retry, since asking again changes nothing; any other failure shows the reason with a Retry (' + ds('Empty, loading, and error') + ')',
    'A scope with nothing in the period says so per section: "No spend in this period", "No model spend in this period", "No agent spend in this period", "No child ITSAs", and each missing tile value reads "—"',
    'An ITSA charted from its own open time says "since KEY opened", and past the 35 days of samples kept it adds "only the last 35 days are kept"',
  ],
  states: [
    { name: 'A tree, 24 agents', routes: { [scopeRoute('tree', 'fx-t1')]: scopeAnswer({ kind: 'tree', id: 'fx-t1', name: 'fixture-tree-a' }) }, setup: drilled(TREE_SCOPE), render: view(TREE_SCOPE) },
    { name: 'A tree, today by hour', routes: { [scopeRoute('tree', 'fx-t1', { days: 1 })]: scopeAnswer({ kind: 'tree', id: 'fx-t1', name: 'fixture-tree-a' }, { days: 1, rows: 24, bucket: 'hour' }) }, setup: drilled(TREE_SCOPE, 1), render: view(TREE_SCOPE) },
    { name: 'An ITSA', data: itsaData(TREE), routes: { [scopeRoute('itsa', ITSA.key, span(ITSA))]: scopeAnswer({ kind: 'itsa', id: ITSA.key, key: ITSA.key, name: name(ITSA) }, { itsa: true }) }, setup: drilled(ITSA_SCOPE), render: view(ITSA_SCOPE) },
    {
      name: 'An ITSA with no children and no closed issue',
      data: itsaData(TREE),
      routes: { [scopeRoute('itsa', ITSA.key, span(ITSA))]: scopeAnswer({ kind: 'itsa', id: ITSA.key, key: ITSA.key, name: name(ITSA) }, { itsa: true, childless: true, windows: [], agents: 2, rows: 2 }) },
      setup: drilled(ITSA_SCOPE), render: view(ITSA_SCOPE),
    },
    {
      name: 'An ITSA older than the samples kept',
      data: itsaData([...TREE, OLD]),
      routes: { [scopeRoute('itsa', OLD.key, span(OLD))]: scopeAnswer({ kind: 'itsa', id: OLD.key, key: OLD.key, name: name(OLD) }, { itsa: true, childless: true }) },
      setup: drilled(OLD_SCOPE), render: view(OLD_SCOPE),
    },
    { name: 'A model', routes: { [scopeRoute('model', MODEL_SCOPE.id)]: scopeAnswer({ kind: 'model', id: MODEL_SCOPE.id, name: 'claude-opus-5-5', harness: 'claude' }, { agents: 8 }) }, setup: drilled(MODEL_SCOPE), render: view(MODEL_SCOPE) },
    { name: 'A harness', routes: { [scopeRoute('harness', 'claude')]: scopeAnswer({ kind: 'harness', id: 'claude', name: 'claude' }, { agents: 13 }) }, setup: drilled(HARNESS_SCOPE), render: view(HARNESS_SCOPE) },
    { name: 'One agent', routes: { [scopeRoute('agent', AGENT.id)]: scopeAnswer({ kind: 'agent', id: AGENT.id, name: AGENT.name }, { agents: 1, rows: 3 }) }, setup: drilled(AGENT_SCOPE), render: view(AGENT_SCOPE) },
    { name: 'Nothing in the period', routes: { [scopeRoute('model', MODEL_SCOPE.id)]: scopeAnswer({ kind: 'model', id: MODEL_SCOPE.id, name: 'claude-opus-5-5', harness: 'claude' }, { empty: true }) }, setup: drilled(MODEL_SCOPE), render: view(MODEL_SCOPE) },
    { name: 'Loading', routes: { [scopeRoute('tree', 'fx-t1')]: sse([]) }, setup: drilled(TREE_SCOPE), render: view(TREE_SCOPE) },
    { name: 'Not found', routes: { [scopeRoute('itsa', 'S-999')]: reply(404, { error: 'fixture: no ITSA S-999' }) }, setup: drilled(scopeOf('itsa', 'S-999')), render: view(scopeOf('itsa', 'S-999')) },
    { name: 'Not visible to you', routes: { [scopeRoute('tree', 'fx-t9')]: reply(403, { error: 'fixture: an agent reads the cost of the ITSAs it belongs to only' }) }, setup: drilled(scopeOf('tree', 'fx-t9')), render: view(scopeOf('tree', 'fx-t9')) },
    { name: 'Failed, with Retry', routes: { [scopeRoute('tree', 'fx-t1')]: reply(503, { error: 'fixture: the scope is unavailable' }) }, setup: drilled(TREE_SCOPE), render: view(TREE_SCOPE) },
    {
      name: 'Status badges', data: itsaData(TREE),
      render: () => <div className="story-pad">{STATUSES.map((s) => <span key={s.name} style={{ marginRight: 'var(--space-2)' }}><StatusBadge status={s.name} /></span>)}</div>,
    },
  ],
}]
