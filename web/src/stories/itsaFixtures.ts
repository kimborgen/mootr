// Invented ITSAs for the ITSA, Work, and requirement stories: a tree with every status category,
// one waiting on the human, a deep chain, and a long board. Keys run from S-910 up (mailFixtures.tsx
// owns S-901). Nobody here is real: owners are fixtures.ts's agents, titles are made up, and the
// times are relative to now so `ago` reads the same.
import type { Data } from '../store'
import type { Itsa, ItsaAction, ItsaAttention, ItsaLink, ItsaQueueRow, ItsaStatus, ItsaView, Rollup } from '../types'
import type { Field } from '../itsa/fields'

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString()

// Every category has at least one status; two are human, one is blocked, three are closed.
export const STATUSES: ItsaStatus[] = [
  { name: 'idea', category: 'backlog', human: false },
  { name: 'backlog', category: 'backlog', human: false },
  { name: 'todo', category: 'ready', human: false },
  { name: 'in_progress', category: 'active', human: false },
  { name: 'blocked', category: 'active', human: false },
  { name: 'needs_input', category: 'active', human: true },
  { name: 'needs_approval', category: 'active', human: true },
  { name: 'in_review', category: 'review', human: false },
  { name: 'ready_to_merge', category: 'review', human: false },
  { name: 'done', category: 'closed', human: false },
  { name: 'canceled', category: 'closed', human: false },
  { name: 'wont_do', category: 'closed', human: false },
]
const CATEGORY = Object.fromEntries(STATUSES.map((s) => [s.name, s.category]))

export const ACTIONS: ItsaAction[] = [
  { id: 'approve', label: 'Approve', to: 'in_progress', text: 'optional' },
  { id: 'changes', label: 'Request changes', to: 'in_progress', text: 'required' },
  { id: 'answer', label: 'Answer', to: 'in_progress', text: 'required' },
]

interface Opts extends Partial<Itsa> { min?: number }
// An ITSA; `min` is its age in minutes (its last change is a fifth of that ago).
export function itsa(n: number, parent: number | null, title: string, status: string, o: Opts = {}): Itsa {
  const { min = 3000, ...rest } = o
  const closed = CATEGORY[status] === 'closed'
  return {
    id: `fx-i-${n}`, key: `S-${n}`, parent_id: parent === null ? null : `fx-i-${parent}`, kind: null, title, summary: null, body: null,
    status, owner: 'fx-dev', thread_id: null, created_by: 'fx-cos', created_at: ago(min), updated_at: ago(Math.round(min / 5)), closed_at: closed ? ago(Math.round(min / 5)) : null,
    ...rest,
  }
}
export const link = (n: number, system: string, external_id: string | null, url: string, meta?: ItsaLink['meta']): ItsaLink => ({ n, system, external_id, url, meta })
const BRANCH = (n: number, name: string, meta?: ItsaLink['meta']) => link(n, 'branch', name, `https://example.com/fixture/repo/tree/${name}`, { repo: 'fixture/repo', ...meta })
const PR = (n: number, num: number) => link(n, 'github', `fixture/repo#${num}`, `https://github.com/fixture/repo/pull/${num}`)
const PREVIEW = (n: number) => link(n, 'preview', 'preview', 'https://preview.example.com/fixture')

// The tree: a root in progress with children in every category and a grandchild waiting on the human.
export const TREE: Itsa[] = [
  itsa(910, null, 'Fixture search rewrite', 'in_progress', { owner: 'fx-cos', kind: 'epic', health: 'on_track', summary: 'Replace the search index and ranker, one slice at a time.', min: 9000 }),
  itsa(911, 910, 'Build the new index', 'in_progress', { owner: 'fx-dev', health: 'at_risk', links: [BRANCH(1, 'fixture/index-builder'), PR(2, 311)], min: 7000 }),
  itsa(912, 911, 'Tokenizer for mixed scripts', 'in_review', { owner: 'fx-review', links: [BRANCH(3, 'fixture/tokenizer', { review: { verdict: 'approved', by: 'fixture-review', summary: null, at: ago(20) }, tests: { passed: 212, failed: 0, skipped: 1, command: 'npm test', at: ago(25) } }), PR(4, 312)], min: 4000 }),
  itsa(913, 912, 'Decide the casing rule for ß', 'needs_input', { owner: 'fx-dev', min: 600 }),
  itsa(914, 911, 'Stemming for four languages', 'todo', { owner: null, min: 3500 }),
  itsa(915, 910, 'Query planner', 'blocked', { owner: 'fx-ops', health: 'off_track', min: 5000 }),
  itsa(916, 910, 'Ranking experiments', 'backlog', { owner: null, min: 8000 }),
  itsa(917, 910, 'Write the migration guide', 'done', { owner: 'fx-dev', min: 6500 }),
  itsa(918, 910, 'Port the old prototype', 'canceled', { owner: null, min: 6000 }),
  itsa(920, null, 'Fixture settings cleanup', 'ready_to_merge', { owner: 'fx-dev', kind: 'issue', links: [BRANCH(5, 'fixture/settings-cleanup'), PR(6, 320)], min: 2000 }),
  itsa(930, null, 'Fixture release notes', 'idea', { owner: null, min: 12000 }),
  itsa(940, null, 'Fixture logging', 'done', { owner: 'fx-dev', min: 20000 }),
  itsa(950, null, 'Approve the new retry policy', 'needs_approval', { owner: 'fx-cos', kind: 'issue', links: [PREVIEW(7)], min: 800 }),
]
export const FIELDS: Field[] = [
  { id: 'fld-area', key: 'area', label: 'Area', type: 'choice', options: [{ value: 'search', label: 'Search', tone: 'accent' }, { value: 'infra', label: 'Infra', tone: 'muted' }, { value: 'risk', label: 'Risky', tone: 'warn' }], description: null, hint: 'The part of the product it touches.', width: 'm', align: 'start', card: 'chip', position: 1 },
  { id: 'fld-est', key: 'estimate', label: 'Estimate', type: 'number', options: null, description: null, hint: null, width: 's', align: 'end', card: 'meta', position: 2 },
  { id: 'fld-due', key: 'due', label: 'Due', type: 'date', options: null, description: null, hint: null, width: 's', align: 'start', card: 'meta', position: 3 },
  { id: 'fld-doc', key: 'doc', label: 'Design doc', type: 'link', options: null, description: null, hint: null, width: 'm', align: 'start', card: 'meta', position: 4 },
  { id: 'fld-note', key: 'note', label: 'Note', type: 'text', options: null, description: null, hint: null, width: 'l', align: 'start', card: 'meta', position: 5 },
  { id: 'fld-flag', key: 'flag', label: 'Needs legal', type: 'check', options: null, description: null, hint: null, width: 's', align: 'start', card: 'chip', position: 6 },
]
// The same tree with values in the fields.
export const TREE_FIELDS: Itsa[] = TREE.map((x) => (x.id === 'fx-i-911'
  ? { ...x, fields: { area: 'search', estimate: 8, due: '2026-11-20', doc: 'https://docs.example.com/fixture/index', note: 'Waits on the tokenizer.', flag: true } }
  : x.id === 'fx-i-915' ? { ...x, fields: { area: 'risk', estimate: 5, due: '2026-10-30' } }
  : x.id === 'fx-i-920' ? { ...x, fields: { area: 'infra' } } : x))

// A chain of seven: the deepest a breadcrumb, a tree, and a board's whole-subtree view meet.
export const DEEP: Itsa[] = [
  itsa(960, null, 'Fixture platform migration', 'in_progress', { owner: 'fx-cos', min: 9000 }),
  itsa(961, 960, 'Move the storage layer', 'in_progress', { min: 8000 }),
  itsa(962, 961, 'Rewrite the blob store', 'in_progress', { min: 7000 }),
  itsa(963, 962, 'Chunked uploads', 'in_progress', { min: 6000 }),
  itsa(964, 963, 'Resume after a dropped connection', 'in_review', { min: 5000 }),
  itsa(965, 964, 'Retry with backoff', 'in_progress', { min: 4000 }),
  itsa(966, 965, 'Jitter the backoff so clients do not move together', 'todo', { owner: null, min: 3000 }),
]

// A long board: 64 children of one root, spread over every status; 16 of them closed.
const LONG_STATUS = ['backlog', 'todo', 'in_progress', 'in_progress', 'blocked', 'in_review', 'done', 'canceled', 'needs_input', 'ready_to_merge', 'idea', 'wont_do']
const LONG_TITLES = ['Rework the retry loop', 'Cache the settings read', 'Fix the stale tab title', 'Tighten the mail list query', 'Explain the quota line', 'Trim the startup log', 'Keep the cursor after a paste', 'Show the machine in the footer', 'Split the long migration', 'Handle a dropped socket']
export const LONG: Itsa[] = [
  itsa(970, null, 'Fixture long-running cleanup', 'in_progress', { owner: 'fx-cos', min: 30000 }),
  ...Array.from({ length: 64 }, (_, i) => itsa(971 + i, 970, `${LONG_TITLES[i % LONG_TITLES.length]}${i >= 10 ? `, part ${Math.floor(i / 10) + 1}` : ''}`, LONG_STATUS[i % LONG_STATUS.length], {
    owner: ['fx-dev', 'fx-review', 'fx-ops', null][i % 4], min: 20000 - i * 250, health: i % 7 === 0 ? 'at_risk' : i % 11 === 0 ? 'on_track' : null,
    kind: i % 9 === 0 ? 'issue' : null, links: i % 5 === 0 ? [PR(1, 400 + i)] : undefined,
  })),
]

// An ITSA waiting on the human, as the attention list holds it.
export const attention = (x: Itsa, min = 40, ask = true): ItsaAttention => ({ ...x, since: ago(min), actions: ACTIONS, ask_thread_id: ask ? 'fx-t-ask' : null, ask_mail_id: null })
export const WAITING_ITSAS: ItsaAttention[] = [
  attention(TREE.find((x) => x.id === 'fx-i-913')!, 35, false),
  attention(TREE.find((x) => x.id === 'fx-i-950')!, 180, false),
]

// Rolled-up counts of an ITSA's direct children by category, from a list.
export function rollup(id: string, all: Itsa[]): Rollup {
  const r: Rollup = { backlog: 0, ready: 0, active: 0, review: 0, closed: 0 }
  for (const x of all) if (x.parent_id === id) r[CATEGORY[x.status] as keyof Rollup]++
  return r
}

// GET /api/itsas/:id for one ITSA of a list.
export function itsaView(id: string, all: Itsa[], o: Partial<ItsaView> = {}): ItsaView {
  const x = all.find((y) => y.id === id)!
  const chain: ItsaView['parent_chain'] = []
  for (let p = all.find((y) => y.id === x.parent_id); p; p = all.find((y) => y.id === p!.parent_id)) chain.unshift({ id: p.id, key: p.key, title: p.title, status: p.status })
  const human = STATUSES.find((s) => s.name === x.status)?.human
  return {
    ...x, participants: ['human', ...(x.owner ? [x.owner] : [])], links: x.links ?? [], parent_chain: chain, rollup: rollup(id, all),
    children: all.filter((y) => y.parent_id === id).map((y) => ({ ...y, rollup: rollup(y.id, all) })),
    events: [
      { id: 3, type: 'status', actor: x.owner ?? 'fx-cos', data: JSON.stringify({ to: x.status }), ts: ago(40) },
      { id: 2, type: 'owner', actor: 'fx-cos', data: JSON.stringify({ to: x.owner }), ts: ago(300) },
      { id: 1, type: 'created', actor: x.created_by, data: null, ts: x.created_at },
    ] as ItsaView['events'],
    actions: human ? ACTIONS : undefined, ...o,
  }
}

// A merge queue row: a ready_to_merge ITSA with a branch.
export const QUEUE: ItsaQueueRow[] = [{
  id: 'fx-i-920', key: 'S-920', title: 'Fixture settings cleanup', owner: 'fx-dev', updated_at: ago(90),
  link: { n: 5, branch: 'fixture/settings-cleanup', repo: 'fixture/repo' },
  facts: { repo: 'fixture/repo', branch: 'fixture/settings-cleanup', path: null, head: 'abc1234', diff: { files: 6, insertions: 142, deletions: 38 }, mergeable: true, behind: 2, error: null },
}]

// The store for a list of ITSAs: the statuses, the waiting ones as attention, and the merge queue.
export function itsaData(all: Itsa[], o: Partial<Data> = {}): Partial<Data> {
  return { itsas: all, itsaStatuses: STATUSES, attention: [], decisions: [], perms: [], queue: [], itsaError: null, ...o }
}

// For OnMount: clicks the first element matching each selector in turn, waiting up to two
// seconds for each to appear (a view that loads from the daemon draws after it mounts).
export const clickWhen = (...selectors: string[]) => (el: HTMLElement) => {
  let i = 0, tries = 0
  const tick = () => {
    const target = el.ownerDocument.querySelector<HTMLElement>(selectors[i])
    if (target) { target.click(); if (++i === selectors.length) return; tries = 0 } else if (++tries > 40) return
    setTimeout(tick, 50)
  }
  tick()
}
