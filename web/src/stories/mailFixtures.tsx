// Invented mail for the mail stories: threads, an ITSA waiting on the human, a permission
// request, a decision, a suggested input. Nobody here is real: the senders are fixtures.ts's
// agents, the text is made up, and the times are relative to now so `ago` reads the same.
import type { ReactNode } from 'react'
import { humanRowsOf } from '../mail/thread-index'
import type { Data } from '../store'
import type { Agent, DecisionMail, ItsaAttention, ItsaStatus, Mail, Permission, Thread } from '../types'
import { AGENTS } from './fixtures'

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString()
const inMin = (min: number) => new Date(Date.now() + min * 60000).toISOString()

export const STATUSES: ItsaStatus[] = [
  { name: 'in_progress', category: 'active', human: false },
  { name: 'blocked', category: 'active', human: false },
  { name: 'needs_input', category: 'active', human: true },
  { name: 'needs_approval', category: 'active', human: true },
  { name: 'in_review', category: 'review', human: false },
  { name: 'done', category: 'closed', human: false },
]

interface MailOpts extends Partial<Mail> { read?: boolean; min?: number }
// A mail from `from` to `to` (agent ids, or 'human'); unread for the human unless `read`.
export function mail(id: string, thread: string, from: string, to: string[], subject: string, body: string, o: MailOpts = {}): Mail {
  const { read = true, min = 60, ...rest } = o
  return {
    id, thread_id: thread, from_id: from, subject, body, created_at: ago(min),
    recipients: to.map((r) => ({ id: r, read_at: r === 'human' && !read ? null : ago(min - 1) })),
    ...rest,
  }
}
const thread = (id: string, mails: Mail[]): Thread => ({ thread_id: id, mails })

const DEV = 'fx-dev', COS = 'fx-cos', REVIEW = 'fx-review', OPS = 'fx-ops'

// A short read thread: a question, an answer, a thanks.
export const T_PLAIN = thread('fx-t-plain', [
  mail('fm-1', 'fx-t-plain', DEV, ['human'], 'Which port does the preview use?', 'The preview server starts on port `4173`. Do you want it on another port?', { min: 190 }),
  mail('fm-2', 'fx-t-plain', 'human', [DEV], 'Re: Which port does the preview use?', 'Keep `4173`.', { min: 120 }),
  mail('fm-3', 'fx-t-plain', DEV, ['human'], 'Re: Which port does the preview use?', 'Done: `4173` stays. Nothing else to change.', { min: 95 }),
])

// A thread with unread mail and a model-given title.
export const T_UNREAD = thread('fx-t-unread', [
  mail('fm-10', 'fx-t-unread', REVIEW, ['human'], 'Review of the retry change: two nits', 'TLDR: The retry change is sound; two nits remain.\n\n- `retry.ts:41` waits one second too long.\n- The test names the old limit.', { read: false, min: 12, title: 'Review nits', verdict: { follows: true, score: 0.9, concise: 0.8, fluff: 0.1, value: 0.9, at: new Date().toISOString() } }),
])

// Mail the sender sent past the mail gate (S-983) with an override reason.
export const T_GATE = thread('fx-t-gate', [
  mail('fm-g1', 'fx-t-gate', DEV, ['human'], 'Deploy finished: one setting changed', 'TLDR: The deploy finished. The retry limit is now 3.', { min: 30, override: 'The retry limit changed, which you asked to hear about.', verdict: null }),
])

// A long thread: sixteen messages, the way a working conversation grows. The panel folds the middle.
const LONG_BODIES = [
  'Starting on the cache fix. First I read `cache.ts` and the two callers.',
  'The entry key ignores the machine, so two machines share one entry. I will add it to the key.',
  'Tests for the key pass. The integration test still fails on the stale entry.',
  'Found it: an entry written before the fix keeps the old key. I add a version prefix.',
  'The version prefix works. Running the wider tests now.',
  'Wider tests pass except one flaky test, unrelated; it passes on a rerun.',
  'Opening the pull request now.',
  'The reviewer asked for a comment on the prefix. Added.',
  'The reviewer approved. Waiting on the checks.',
  'Checks are green. Ready to merge.',
  'A late finding: the docs name the old key shape. Updating them.',
  'Docs updated; checks rerun.',
  'Checks green again.',
  'Merged. The deploy watcher will pick it up.',
  'Deployed. The cache now keys by machine; I saw no stale entries in the first hour.',
]
export const T_LONG = thread('fx-t-long', [
  ...LONG_BODIES.map((b, i) => mail(`fm-2${i}`, 'fx-t-long', DEV, ['human'], i === 0 ? 'Cache fix progress' : 'Re: Cache fix progress', b, { min: 900 - i * 55, read: i < 13 })),
  mail('fm-2x', 'fx-t-long', 'human', [DEV], 'Re: Cache fix progress', 'Thanks. Close it out once the hour is clean.', { min: 20 }),
])

// A mail rich in components, as an agent writes them.
export const T_RICH = thread('fx-t-rich', [
  mail('fm-30', 'fx-t-rich', COS, ['human'], 'Pick the cache lifetime', 'TLDR: The fix works; pick the cache lifetime.\n\n```decision\nHow long should a cache entry live?\n- 1 hour: always fresh, more reads (recommended)\n- 12 hours: fewer reads\n```\n\n```metrics\nTests: 214/214 [success]\nCache hits: 71%\n```\n\nSee S-901 for the plan.', { min: 40, read: false, kind: null }),
])

// An ITSA waiting on the human: its ask is the last mail of the thread.
export const ASK_ITSA: ItsaAttention = {
  id: 'fx-itsa-1', key: 'S-901', parent_id: null, kind: 'issue', title: 'Fixture cache lifetime', summary: null, body: null,
  status: 'needs_input', owner: DEV, thread_id: 'fx-t-ask', created_by: COS, created_at: ago(300), updated_at: ago(30), closed_at: null,
  since: ago(30), ask_thread_id: 'fx-t-ask', ask_mail_id: 'fm-41',
  actions: [{ id: 'approve', label: 'Approve', to: 'in_progress', text: 'optional' }, { id: 'changes', label: 'Request changes', to: 'in_progress', text: 'required' }, { id: 'answer', label: 'Answer', to: 'in_progress', text: 'required' }],
}
export const T_ASK = thread('fx-t-ask', [
  mail('fm-40', 'fx-t-ask', DEV, ['human'], 'S-901 Fixture cache lifetime', 'The cache lifetime needs a number.', { min: 35, itsa_id: 'fx-itsa-1', about_itsa: 'fx-itsa-1', kind: 'comment' }),
  mail('fm-41', 'fx-t-ask', DEV, ['human'], 'S-901 Fixture cache lifetime', 'The cache lifetime needs a number.\n\nI need a lifetime for cache entries: one hour or twelve. One hour keeps data fresh; twelve halves the reads.', { min: 30, read: false, itsa_id: 'fx-itsa-1', about_itsa: 'fx-itsa-1', kind: 'ask', reply_to: 'fm-40' }),
])

// A permission request and a dialog stopping an agent.
const PERM: Permission = { id: 'fx-perm-1', agent_id: OPS, agent_name: 'fixture-ops', machine: 'fixture-machine', status: 'pending', kind: 'request', action: 'Run `npm test` in the project folder', reason: 'The change touches shared code.', created_at: ago(8), audience: 'human' }
const DIALOG: Permission = { ...PERM, id: 'fx-perm-2', kind: 'dialog', dialog: 1, action: 'Claude Code asks to allow editing config.json', created_at: ago(6) }
export const T_PERM = thread('fx-t-perm', [
  mail('fm-50', 'fx-t-perm', OPS, ['human'], 'Permission: run the tests', 'Run `npm test` in the project folder?', { min: 8, read: false, permission_id: PERM.id, permission: PERM }),
])
export const T_DIALOG = thread('fx-t-dialog', [
  mail('fm-51', 'fx-t-dialog', OPS, ['human'], 'Dialog: allow editing config.json', 'fixture-ops is stopped on a dialog.', { min: 6, read: false, permission_id: DIALOG.id, permission: DIALOG }),
])
// A question dialog (AskUserQuestion, S-3978): its card offers one button per option, and Deny.
const QUESTION: Permission = { ...DIALOG, id: 'fx-perm-q', action: 'Claude Code asks a question', details: JSON.stringify({ tool: 'AskUserQuestion', input: { questions: [{ question: 'Which folder should the migration use for the backup copy of the customer data?', options: [
  { label: 'Shared backups', description: 'The team folder, kept for 30 days.' },
  { label: 'Project backups', description: 'A new folder next to the project, removed when the migration ends.' },
  { label: 'External drive', description: 'The drive mounts only while a backup runs, so the copy waits until it is connected and the migration pauses until then.' },
  { label: 'No backup', description: 'Continue without a copy.' },
] }] }, session: 'fx-session' }) }
export const T_QUESTION = thread('fx-t-question', [
  mail('fm-53', 'fx-t-question', OPS, ['human'], 'Dialog: which folder', 'fixture-ops is stopped on a question.', { min: 4, read: false, permission_id: QUESTION.id, permission: QUESTION }),
])
export const PERM_DONE: Permission = { ...PERM, id: 'fx-perm-3', status: 'approved', decided_by: 'human', decided_at: ago(4), note: 'Go ahead' }
export const T_PERM_DONE = thread('fx-t-perm-done', [
  mail('fm-52', 'fx-t-perm-done', OPS, ['human'], 'Permission: run the tests', 'Run `npm test` in the project folder?', { min: 20, permission_id: PERM_DONE.id, permission: PERM_DONE }),
])

// A suggested input (S-422): the text an agent would type, which only the human approves.
export const INPUT: Permission = { id: 'fx-perm-4', agent_id: DEV, agent_name: 'fixture-dev', machine: 'fixture-machine', status: 'pending', kind: 'input', text: '/compact keep the open questions', reason: 'The context is 85% full; compacting keeps the work going.', expires_at: inMin(42), created_at: ago(3), sha256: 'fixture' }
export const inputWith = (o: Partial<Permission>): Permission => ({ ...INPUT, ...o })
export const T_INPUT = thread('fx-t-input', [
  mail('fm-60', 'fx-t-input', DEV, ['human'], 'Suggested input for fixture-dev', 'fixture-dev suggests an input.', { min: 3, read: false, permission_id: INPUT.id, permission: INPUT }),
])

// A thread whose last mail is the human's: awaiting an answer.
export const T_AWAIT = thread('fx-t-await', [
  mail('fm-70', 'fx-t-await', 'human', [COS], 'Can the report wait until Friday?', 'Can the usage report wait until Friday?', { min: 300 }),
])

// A decision mail the human hasn't answered.
export const DECISION: DecisionMail = { mail_id: 'fm-30', thread_id: 'fx-t-rich', from_id: COS, from_name: 'fixture-cos', subject: 'Pick the cache lifetime', created_at: ago(40) }

// An archived thread.
export const T_ARCH = thread('fx-t-arch', [
  mail('fm-80', 'fx-t-arch', REVIEW, ['human'], 'Review done: wide tables', 'The review is done; nothing to change.', { min: 2900 }),
  mail('fm-81', 'fx-t-arch', 'human', [REVIEW], 'Re: Review done: wide tables', 'Thanks.', { min: 2880 }),
])

// A mail withdrawn from the human once another reviewer settled it.
export const T_WITHDRAWN = thread('fx-t-withdrawn', [
  mail('fm-90', 'fx-t-withdrawn', OPS, ['human'], 'Permission: install a package', 'Install `left-pad`?', { min: 50, recipients: [{ id: 'human', read_at: ago(49), withdrawn_at: ago(45), withdrawn_by: COS, withdrawn_note: 'fixture-cos denied it' }] }),
  mail('fm-91', 'fx-t-withdrawn', COS, ['human'], 'Re: Permission: install a package', 'I denied it: the package is not needed.', { min: 44 }),
])

// Two agents talking in a thread the human takes part in (S-1458): their mail is not addressed to the human.
export const T_BETWEEN = thread('fx-t-between', [
  mail('fm-95', 'fx-t-between', COS, ['human'], 'Pick a token lifetime', 'Which lifetime for SSO tokens?', { min: 30 }),
  mail('fm-96', 'fx-t-between', COS, [OPS], 'Re: Pick a token lifetime', 'Can you check the current lifetime before I ask again?', { min: 20 }),
  mail('fm-97', 'fx-t-between', OPS, [COS], 'Re: Pick a token lifetime', 'It is 12 hours.', { min: 15 }),
  mail('fm-98', 'fx-t-between', COS, ['human'], 'Re: Pick a token lifetime', 'Keep 12 hours, or shorten it?', { min: 5 }),
])

export const ALL_THREADS = [T_UNREAD, T_RICH, T_ASK, T_PERM, T_PLAIN, T_AWAIT, T_LONG]

// An agent list where `fixture-ops` waits on the human in the ask's thread, and a pending dialog stops it.
export const AGENTS_STOPPED: Agent[] = AGENTS.map((a) => (a.id === OPS ? { ...a, waits: [{ id: 'w-h', kind: 'human', since: ago(8), source: 'wait_for', thread: 'fx-t-ask' }] } : a))

// The inbox with everything waiting on the human: an ITSA's ask, a request, a decision.
export const WAITING: Partial<Data> = {
  humanRows: humanRowsOf(ALL_THREADS, [T_ARCH]), unread: 4,
  itsaStatuses: STATUSES, attention: [ASK_ITSA], decisions: [DECISION], perms: [PERM],
  itsas: [ASK_ITSA],
}

// The routes a thread world asks.
export const threadRoutes = (...ts: Thread[]): Record<string, unknown> => Object.fromEntries(ts.map((t) => [`GET /api/threads/${t.thread_id}`, t.mails]))
export const ASK_ROUTE = { 'GET /api/itsas/fx-itsa-1': { ...ASK_ITSA, actions: ASK_ITSA.actions } }

// A pane as the app gives one: a fixed height, so a thread scrolls inside it and its reply box stays at the foot.
export const Pane = ({ children, height = 640 }: { children: ReactNode; height?: number }) => <div style={{ height, display: 'flex', flexDirection: 'column' }}>{children}</div>

// Rapid-fire mode (S-1004): ideas you fired at fixture-dev, one thread each, oldest first; some
// answered (one unread), some with a follow-up of yours. `n` threads, for a realistic scale.
const IDEAS = ['Cache the model list per machine', 'A dark-mode toggle in the phone header', 'Rename "deferred" to "later" in the mail list',
  'Show the cost window in the Work page title', 'Let the Swipe view undo two steps', 'Group retros by evidence', 'A keyboard shortcut to open the last thread',
  'Fold tool runs longer than ten calls', 'Warn before an agent hits its context limit', 'Pin the chief of staff to the top of the tree']
export function rapidThreads(n = 6): Thread[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `fx-rf-${i}`, min = (n - i) * 7
    const idea = IDEAS[i % IDEAS.length] + (i >= IDEAS.length ? ` (${Math.floor(i / IDEAS.length) + 1})` : '')
    const ms: Mail[] = [mail(`fm-rf-${i}-a`, id, 'human', [DEV], idea, idea + '. Worth a small ITSA?', { min })]
    if (i % 3 === 1) ms.push(mail(`fm-rf-${i}-b`, id, DEV, ['human'], 'Re: ' + idea, 'Filed it as a small change; a developer picks it up next.', { min: min - 3, read: i !== n - 2 }))
    if (i % 4 === 2) ms.push(mail(`fm-rf-${i}-c`, id, 'human', [DEV], 'Re: ' + idea, 'And on the phone too.', { min: min - 4 }))
    return thread(id, ms)
  })
}

// One card per kind (S-1312): a summary in the contract of its kind, the mail check's verdict kind marking it.
const V = (kind: string) => ({ follows: true, score: 0.9, concise: 0.8, fluff: 0.1, value: 0.9, kind, at: new Date().toISOString() })
export const kinded = (id: string, kind: string, subject: string, summary: string, o: { read?: boolean } = {}): Thread => ({ thread_id: id, mails: [{ ...mail('fm-' + id, id, 'fx-dev', ['human'], subject, 'Long body.', { read: o.read ?? false, min: 12 }), verdict: V(kind), summary } as never] })
export const T_K_DECISION = kinded('fx-k-dec', 'decision', 'Which token lifetime should SSO sessions get?', 'Which token lifetime should SSO sessions get?\n- 1h: safest, users re-login daily (recommended)\n- 12h: one login per workday\n- 7d: only with the admin override on\n- Per tenant: each tenant sets its own, more settings to support')
export const T_K_BLOCKER = kinded('fx-k-blk', 'blocker', 'Nightly e2e run stuck on the Chromium lock', 'Problem: The nightly e2e run waits on the Chromium lock that agent `fx-ops` holds since 02:10.\nSolution: Kill that run by its PID, then rerun `test/e2e-ui.sh`. Needs your OK because it ends another agent\'s work (S-12).')
export const T_K_DONE = kinded('fx-k-done', 'done', 'SSO login fixed', 'Problem: SSO users saw a 401 after the token refresh.\nSolution: The refresh now sends the `Authorization` header, merged in PR #356.\nDeferred: Retry on a second 401.\nNote: Redeploy the gateway before testing.', { read: true })
export const T_K_GENERAL = kinded('fx-k-gen', 'other', 'Nightly build report', 'The nightly build ran every suite on both machines and all of them passed.\n- unit: 41s\n- e2e: 6m', { read: true })
export const T_K_LONG = kinded('fx-k-long', 'blocker', 'Re: The deploy watcher cannot reach the storage machine over the tunnel after the network change on Thursday night (S-1200)', 'Problem: The deploy watcher cannot reach `storage` over the tunnel, so every deploy since Thursday waits and the retry loop fills the log with the same timeout error every ten seconds.\nSolution: Restart the tunnel unit on `storage` and pin its keepalive to 30 seconds.')
export const T_K_OLD = kinded('fx-k-old', 'decision', 'Old style decision', 'SSO login works again after the fix in PR #356. Pick a token lifetime before Friday, 1h or 12h.')
