import type { AboutThread, CostModes, Itsa, ItsaThreadItem, ItsaView as View, Mail } from '../types'
import { ASK_ITSA, mail, PERM_DONE, T_ASK } from '../stories/mailFixtures'
import { attention, itsa, itsaData, itsaView, LONG, TREE, DEEP } from '../stories/itsaFixtures'
import { BATCH_ITEMS, REQS } from '../stories/reqFixtures'
import { refreshReq } from '../req/store'
import { ds, reply, type Story } from '../stories/types'
import type { ItsaActivityReport } from '../work/links'
import { resetDiffRepos } from '../diff/diffRepos'
import { CostLine, ItsaView } from './ItsaView'

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString()
const pane = (id: string) => <div style={{ height: 760, overflow: 'auto' }}><ItsaView id={id} viewKey={'itsa:' + id} /></div>
const modes = (api: number | null, o: Partial<CostModes> = {}): CostModes => ({ api, five_hour: api === null ? null : api * 0.5, seven_day: api === null ? null : api * 0.2, subscription: api, paid_usd: 0, ...o })

const BODY = '## Goal\n\nBuild the new index so a query reads one file, not three.\n\n- Segment files are immutable once written.\n- `merge()` runs in the background.\n\n```ts\nconst hits = index.query("fixture", { limit: 10 })\n```\n\nSee S-912 for the tokenizer.'

// The thread of S-911: an owner\'s update with a health, a comment, and the status changes between.
const THREAD: ItsaThreadItem[] = [
  { type: 'event', ts: ago(900), id: 1, actor: 'fx-cos', event: 'status', text: 'set the status to in progress' },
  { type: 'mail', ts: ago(600), mail: mail('fm-i1', 'fx-t-i911', 'fx-dev', ['human'], 'S-911 Build the new index', 'Segments write and read back. The merge step is next.', { min: 600, kind: 'update', health: 'on_track' } as Partial<Mail>) },
  { type: 'mail', ts: ago(120), mail: mail('fm-i2', 'fx-t-i911', 'human', ['fx-dev'], 'S-911 Build the new index', 'Keep the segment size under 64 MB.', { min: 120, kind: 'comment' }) },
  { type: 'mail', ts: ago(30), mail: mail('fm-i3', 'fx-t-i911', 'fx-dev', ['human'], 'S-911 Build the new index', 'The merge step is slower than planned: it holds a lock the writer needs. I am looking at a lock-free swap.', { min: 30, kind: 'update', health: 'at_risk' } as Partial<Mail>) },
]
// A table wider than the pane, and two agents talking in the thread (S-1453, S-1458).
const WIDE = '| Segment | Size (MB) | Records | Written at | Merged into | Checksum | Notes |\n|---|---|---|---|---|---|---|\n| seg-0001 | 61 | 1,204,331 | 2026-10-16 09:12 | seg-0007 | 9f3a2c71b0e4 | Oldest, compacted |\n| seg-0002 | 58 | 1,190,004 | 2026-10-16 09:40 | seg-0007 | 51ce08a2d9f3 | Compacted |\n| seg-0003 | 12 | 233,918 | 2026-10-17 07:05 | none | c04b77e1aa52 | Live |'
const THREAD_WIDE: ItsaThreadItem[] = [
  ...THREAD,
  { type: 'mail', ts: ago(20), mail: mail('fm-i5', 'fx-t-i911', 'fx-cos', ['fx-dev'], 'S-911 Build the new index', 'Can you attach the checksum list for seg-0003 before I ask Kim to review?', { min: 20, kind: 'comment' }) },
  { type: 'mail', ts: ago(12), mail: mail('fm-i4', 'fx-t-i911', 'fx-dev', ['human'], 'S-911 Build the new index', 'The segment report after the merge:\n\n' + WIDE, { min: 12, kind: 'update' }) },
  { type: 'mail', ts: ago(5), mail: mail('fm-i6', 'fx-t-i911', 'fx-dev', ['human'], 'S-911 Build the new index', 'Checksums are in the table above. Ready for review.', { min: 5, kind: 'comment' }) },
]
const THREAD_PERM: ItsaThreadItem[] = [
  ...THREAD,
  { type: 'mail', ts: ago(8), mail: mail('fm-i7', 'fx-t-i911', 'fx-dev', ['human'], 'Permission: run the tests', 'Run `npm test` in the project folder?', { min: 8, permission_id: PERM_DONE.id, permission: PERM_DONE }) },
]
// The tool calls each agent mail of THREAD_WIDE was sent after (S-1643), from the sender's view; an empty answer draws no drawer.
const CALL = (id: string, name: string, input: Record<string, string>, output: string): { id: string; name: string; input: Record<string, string>; output: string; status: 'done' } => ({ id, name, input, output, status: 'done' })
// A long run of calls, as a real turn makes: reads, greps and edits over one segment tree (S-1643, the drawer at scale).
const LONG_RUN = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => i % 3 === 0
  ? CALL(`${prefix}${i}`, 'Read', { file_path: `src/segments/part-${i}.ts` }, `export const part${i} = ${i}`)
  : i % 3 === 1 ? CALL(`${prefix}${i}`, 'Grep', { pattern: `segment-${i}` }, `src/segments/part-${i}.ts:${i}`)
  : CALL(`${prefix}${i}`, 'Edit', { file_path: `src/segments/part-${i - 2}.ts` }, 'The file has been updated.'))
const TOOL_ROUTES: Record<string, unknown> = {
  'GET /api/agents/fx-dev/view/tools?mail=fm-i1': { tools: [
    ...LONG_RUN('r', 14),
    CALL('c2', 'Bash', { command: 'npm test -- segments' }, '142 passed'),
    CALL('c3', 'Edit', { file_path: 'src/segments/merge.ts' }, 'The file has been updated.'),
  ] },
  'GET /api/agents/fx-dev/view/tools?mail=fm-i3': { tools: [CALL('c4', 'Bash', { command: 'git log --oneline -5' }, 'a1b2c3d merge lock notes')] },
  'GET /api/agents/fx-cos/view/tools?mail=fm-i5': { tools: [CALL('c5', 'Grep', { pattern: 'seg-0003' }, 'checksums.txt:3'), CALL('c6', 'Read', { file_path: 'checksums.txt' }, 'c04b77e1aa52 seg-0003')] },
  'GET /api/agents/fx-dev/view/tools?mail=fm-i4': { tools: [...LONG_RUN('q', 12), CALL('c7', 'Bash', { command: 'ls segments/' }, 'seg-0001 seg-0002 seg-0003')] },
  'GET /api/agents/fx-dev/view/tools?mail=fm-i6': { tools: [] },
}
const ABOUT: AboutThread[] = [
  { thread_id: 'fx-t-a1', subject: 'Re: Which merge strategy for the index?', participants: ['human', 'fx-dev', 'fx-review'], last_at: ago(50), unread: 1 },
  { thread_id: 'fx-t-a2', subject: 'Review of the segment writer', participants: ['human', 'fx-review', 'fx-dev', 'fx-ops', 'fx-cos'], last_at: ago(400), unread: 0 },
]
const ACTIVITY = (key: string): ItsaActivityReport => ({
  note: 'Fixture activity.', since: ago(20000), rows: [{
    key, category: 'active', created_at: ago(7000), closed_at: null, lead_s: null, review_rounds: 2,
    own: { working_s: 5400, waiting_s: 1800, working_by_kind: {}, waiting_by_top: { human: 900, agent: 600, job: 300 }, waiting_by_kind: { 'human.reply': 600, 'human.approval': 300, 'agent.wait': 600, 'job.test': 300 }, cost_usd: 4.2 },
    total: { working_s: 14400, waiting_s: 6300, working_by_kind: {}, waiting_by_top: { human: 3600, agent: 1800, job: 900 }, waiting_by_kind: { 'human.reply': 2400, 'human.approval': 1200, 'agent.wait': 1800, 'job.test': 900 }, cost_usd: 11.7 },
    agents: [{ id: 'fx-dev', name: 'fixture-dev', working_s: 9000 }, { id: 'fx-review', name: 'fixture-review', working_s: 3000 }],
  }],
})
const COST = {
  note: 'Claude and Codex dollars are API-equivalent estimates, not what a subscription bills.', own: { cost_usd: 4.2 }, total: { cost_usd: 11.7 },
  agents: [{ agent: 'fixture-dev', id: 'fx-dev', cost_usd: 3.1, share: 0.74 }, { agent: 'fixture-review', id: 'fx-review', cost_usd: 1.1, share: 0.26 }],
  config: 'claude-opus-5-5 · effort medium', weekly_percent: 1.84, cost: { mode: 'api' as const, own: modes(4.2), total: modes(11.7) },
}

interface World { all: Itsa[]; id: string; view?: Partial<View>; thread?: ItsaThreadItem[]; about?: AboutThread[]; cost?: unknown; activity?: boolean }
// The daemon's answers for one ITSA; whatever a world leaves out answers 404 and its section stays empty.
function routes(w: World): Record<string, unknown> {
  const x = w.all.find((y) => y.id === w.id)!
  return {
    [`GET /api/itsas/${w.id}`]: itsaView(w.id, w.all, { thread_id: w.thread ? 'fx-t-i911' : null, ...w.view }),
    ...(w.thread ? { [`GET /api/itsas/${w.id}/thread`]: { items: w.thread } } : {}),
    [`GET /api/itsas/${w.id}/threads`]: w.about ?? [],
    ...(w.cost ? { [`GET /api/itsas/${w.id}/cost`]: w.cost } : {}),
    ...(w.activity ? { 'GET /api/activity?by=itsa': ACTIVITY(x.key) } : {}),
  }
}
const FULL: World = { all: TREE, id: 'fx-i-911', view: { body: BODY, summary: 'Replace the three index files with one segment store.' }, thread: THREAD, about: ABOUT, cost: COST, activity: true }
const SIMPLE = (all: Itsa[], id: string, view: Partial<View> = {}): World => ({ all, id, view })
const ONE = (status: string): Itsa[] => [itsa(990, null, 'Fixture one-off task', status, { owner: status === 'idea' || status === 'backlog' || status === 'canceled' ? null : 'fx-dev', summary: 'A small change with no children and no thread yet.' })]
const world = (w: World, extra: Record<string, unknown> = {}, data: Partial<Parameters<typeof itsaData>[1]> = {}) => ({ data: itsaData(w.all, data), routes: { ...routes(w), ...extra } })

const reqOn = { 'GET /api/req-enabled': { enabled: true }, 'GET /api/requirements?verdicts=latest': REQS }
const refresh = () => { void refreshReq() }
const batch: World = { all: TREE, id: 'fx-i-950', view: { kind: 'requirement-approval', summary: 'Two drafts and a dropped one, asked together.', body: 'R-8, R-9 and R-10, drafted from the retry-policy review.' } }
const waiter: World = { all: TREE, id: 'fx-i-913', view: { summary: 'Does the ß fold to ss when the query is upper-cased?', thread_id: 'fx-t-ask' }, thread: [{ type: 'mail', ts: ago(35), mail: T_ASK.mails[1] }] }
const asking = { attention: [{ ...attention(TREE.find((x) => x.id === 'fx-i-913')!, 35), ask_thread_id: 'fx-t-ask' }, ASK_ITSA], humanThreads: [T_ASK] }

export const stories: Story[] = [{
  name: 'ITSA view',
  group: 'ITSA and work',
  what: 'One ITSA\'s own page: the chain of parents as a breadcrumb; the header (key, title, status, owner, kind, health, cost); a "Waiting on you" box with the action buttons when it is in a human status; the summary and body; the owner\'s latest update; the children with a roll-up; the requirements linked to it; links; participants; time and cost; mail about it; and its thread, or its activity until a thread exists. A comment box posts to the participants and, if you staged an action, applies it: on a desktop it is the bottom world\'s prompt input (this view publishes it through `bottom-slot.ts`), on a phone a box at the foot of the page.',
  when: 'The `w:itsa:ID` world (view key `itsa:ID`): a click on an ITSA anywhere (a row, card, key in mail, breadcrumb, Work row). On a desktop opened from a mail it takes the thread\'s right split; on a phone it is a pushed view and Back returns to the thread.',
  code: ['web/src/views/ItsaView.tsx#ItsaView', 'web/src/views/ItsaView.tsx#itsaTitles', 'web/src/views/ItsaView.tsx#ThreadItems', 'web/src/mail/MailTools.tsx#MailTools'],
  rules: [
    'The thread opens at its latest message (S-1500): the page scrolls once to the end of the thread when it first loads, as a mail thread does.',
    'The thread is conversation turns (S-1508): every mail in full as a card with its sender and recipients (`ConvMailCard`), mail between agents too, so tables scroll sideways and the other mail components render as in mail. Status changes stay one-line events between the cards, and stam system mail a notice line. Decisions show but can\'t be answered here; a card has no Open thread button. Attachments, the superseded line and the verdict mark show in the card; a mail with a permission is the mail view\'s own card, with the chip above it.',
    'Before a mail an agent sent, its tool calls since its turn began show as one closed drawer above the card, the conversation\'s ToolGroup with its summaries (S-1643). Each mail\'s calls are read from the sender\'s view when its card scrolls in; mail from you has none, and a sender with no view or no calls draws nothing.',
    'Mail from you has an accent left rail and a "From you" chip in the card header; mail to you has a success left rail and a "To you" chip, so the two read apart in light and dark. Mail between agents has neither.',
    'The status button wears its category\'s glyph and `--is-*` tone, and its title says the category and, for a human status, "waits on you"; owner and status open the same menus as the Board (' + ds('Modals and menus') + ').',
    'A status or owner change shows at once with "saving…" and `aria-busy`, and rolls back with the reason if refused.',
    'Waiting on you is a hairline box, not a filled one: a warning-toned label with the user icon, what it holds up, and the buttons; staging a button shows a hint saying where it goes and what text it needs (' + ds('State vocabulary') + ').',
    'Health is a dot and a word (On track, At risk, Off track) in the success, warning or error tone, from the owner\'s latest update.',
    'Children: open ones first, then closed (muted); each has its glyph, key, roll-up bar, status words, and owner. An empty list says how to add one. A child being added shows as "adding" until the daemon has it.',
    'Rows are at least `--size-row-table` (28 px) tall and `--size-hit-touch` on a phone, where the child row wraps to two lines (' + ds('Density') + ').',
    'Links: a PR link, and a branch link of an ITSA with one PR in the same repo, get a "View diff" button (S-1533) that opens `diff:REPO#N` in a pane. It shows only for a repo the diff API serves, so another repo\'s PR has the link alone, never a dead button. The row keeps its height (`--size-row-table`, `--size-hit-touch` on a phone, where the button is a full touch target), so it does not move when the served repos arrive.',
    'The header\'s load failure replaces the page with "Can\'t show this ITSA" and the reason, in place and not as a toast (' + ds('Empty, loading, and error') + ').',
  ],
  states: [
    { name: 'Active, with everything', ...world(FULL) , render: () => pane('fx-i-911') },
    { name: 'Thread with mail from you, to you, and between agents', ...world({ ...FULL, thread: THREAD_WIDE }), render: () => pane('fx-i-911') },
    { name: 'Thread with a permission mail to you', ...world({ ...FULL, thread: THREAD_PERM }), render: () => pane('fx-i-911') },
    { name: 'Thread with the tool calls before each agent mail', ...world({ ...FULL, thread: THREAD_WIDE }, TOOL_ROUTES), render: () => pane('fx-i-911') },
    { name: 'Waiting on you', ...world(waiter, {}, asking), render: () => pane('fx-i-913') },
    { name: 'With linked requirements', ...world(FULL, reqOn), setup: refresh, render: () => pane('fx-i-911') },
    { name: 'A batch approval of requirement drafts', ...world(batch, { ...reqOn, 'GET /api/requirements/asks/fx-i-950': { itsa: 'fx-i-950', items: BATCH_ITEMS } }), setup: refresh, render: () => pane('fx-i-950') },
    { name: 'Backlog', ...world(SIMPLE(ONE('backlog'), 'fx-i-990')), render: () => pane('fx-i-990') },
    { name: 'Ready', ...world(SIMPLE(ONE('todo'), 'fx-i-990')), render: () => pane('fx-i-990') },
    { name: 'In review', ...world(SIMPLE(ONE('in_review'), 'fx-i-990', { links: [{ n: 1, system: 'github', external_id: 'fixture/repo#901', url: 'https://github.com/fixture/repo/pull/901' }] })), render: () => pane('fx-i-990') },
    { name: 'Links with View diff', ...world(SIMPLE(ONE('in_review'), 'fx-i-990', { links: [
        { n: 1, system: 'branch', external_id: 'fixture/diff-entry', url: '', meta: { repo: 'fixture' } },
        { n: 2, system: 'github', external_id: '901', url: 'https://github.com/fixture/repo/pull/901' },
        { n: 3, system: 'github', external_id: '12', url: 'https://github.com/other/thing/pull/12' },
      ] })), setup: () => resetDiffRepos([{ name: 'fixture', github: 'fixture/repo' }], true), render: () => pane('fx-i-990') },
    { name: 'Closed: done', ...world(SIMPLE(ONE('done'), 'fx-i-990')), render: () => pane('fx-i-990') },
    { name: 'Closed: canceled', ...world(SIMPLE(ONE('canceled'), 'fx-i-990')), render: () => pane('fx-i-990') },
    { name: 'Blocked, off track', ...world(SIMPLE(TREE, 'fx-i-915', { health: 'off_track', summary: 'Waits on the index format.' })), render: () => pane('fx-i-915') },
    { name: 'A deep chain: seven levels of parents', ...world(SIMPLE(DEEP, 'fx-i-966')), render: () => pane('fx-i-966') },
    { name: 'A root with 64 children', ...world(SIMPLE(LONG, 'fx-i-970', { summary: 'Long-running cleanup of small issues.' })), render: () => pane('fx-i-970') },
    { name: 'Saving a status change', ...world(SIMPLE(TREE, 'fx-i-914')), data: itsaData(TREE.map((x) => (x.id === 'fx-i-914' ? { ...x, status: 'in_progress', pending: true } : x))), render: () => pane('fx-i-914') },
    { name: 'The Retros ITSA', ...world(SIMPLE([itsa(991, null, 'Retros', 'in_progress', { kind: 'retros' })], 'fx-i-991'), {
      'GET /api/retros': { items: [
        { id: 'fx-ri-1', key: 'S-992', title: 'A test loop wasted ten minutes', kind: 'improve', target: 'docs/testing.md', plusOnes: 2, status: 'backlog', created_at: ago(900) },
        { id: 'fx-ri-2', key: 'S-993', title: 'The flock trick for shared machines', kind: 'went_well', target: 'none', plusOnes: 0, status: 'backlog', created_at: ago(600) },
      ], effort: [{ model: 'claude-haiku-5-5', type: 'developer', rounds: 6, avg: { reading: 24, implementing: 41, testing: 20, waiting: 9, review_fixes: 4, coordination: 2 } }], coverage: { archived: 9, withRound: 8, without: ['fixture-old'] } } }), render: () => pane('fx-i-991') },
    { name: 'Error', data: itsaData(TREE), routes: { 'GET /api/itsas/fx-i-911': reply(404, { error: 'fixture: no such ITSA' }) }, render: () => pane('fx-i-911') },
  ],
}, {
  name: 'ITSA cost line',
  group: 'ITSA and work',
  what: 'One line in the ITSA view\'s header with what the ITSA has cost: its own spend, then the total with its children, and its share of the week. It unfolds to the agents behind the spend and the config they ran on. It is hidden until the cost is above zero, and a failed read shows nothing.',
  when: 'In the ITSA view\'s header (`w:itsa:ID`), after the health. The unit is the one you picked in Settings: API-equivalent dollars, a share of the 5-hour or 7-day window, or the subscription; real paid spend shows beside it.',
  code: ['web/src/views/ItsaView.tsx#CostLine'],
  rules: [
    'A value that cannot be worked out yet (no price set, or the window is not calibrated) shows an en dash with the reason in its title, never zero.',
    'The share of the week shows in the dollar units only, since a window unit already is that share.',
    'The unfolded list shows each agent\'s dollars and share of this ITSA\'s own spend; those stay API-equivalent dollars whatever the unit.',
    'The hover text says dollars are API-equivalent estimates, not what a subscription bills (' + ds('Persona rules') + ').',
  ],
  states: [
    { name: 'Own and with children', routes: { 'GET /api/itsas/fx-i-911/cost': COST }, render: () => <div className="itsa-props"><CostLine id="fx-i-911" /></div> },
    { name: 'Own only', routes: { 'GET /api/itsas/fx-i-911/cost': { ...COST, total: COST.own, cost: { ...COST.cost, total: modes(4.2) } } }, render: () => <div className="itsa-props"><CostLine id="fx-i-911" /></div> },
    { name: 'Seven-day window', routes: { 'GET /api/itsas/fx-i-911/cost': { ...COST, cost: { mode: 'seven_day', own: modes(4.2), total: modes(11.7) } } }, render: () => <div className="itsa-props"><CostLine id="fx-i-911" /></div> },
    { name: 'No price yet, with paid spend', routes: { 'GET /api/itsas/fx-i-911/cost': { ...COST, cost: { mode: 'subscription', own: modes(null, { paid_usd: 1.5 }), total: modes(null, { paid_usd: 3 }) } } }, render: () => <div className="itsa-props"><CostLine id="fx-i-911" /></div> },
    { name: 'No cost yet, so nothing shows', routes: { 'GET /api/itsas/fx-i-911/cost': { ...COST, own: { cost_usd: 0 }, total: { cost_usd: 0 } } }, render: () => <p className="muted">Nothing between the lines:<CostLine id="fx-i-911" /></p> },
  ],
}]
