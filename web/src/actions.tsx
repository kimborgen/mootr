// What the UI does: selecting worlds, adding agents and terminals, the agent menu, the tree
// view, permission answers, and the executive assistant.
import { api } from './api'
import { moveDraft } from './Composer'
import { optimistic } from './optimistic'
import { live, plainSubject } from './format'
import { Glyph, PlainGlyph } from './Glyph'
import * as shell from './shell/layout'
import { spawnMenu } from './spawn'
import { followsSettings } from './permission-modes'
import { assistant, byId, chiefAssistants, chiefsOfStaff, childrenOf, getData, hasPendingPermission, isArchivedThread, isDeferredThread, refresh, refreshSlow, setData, threadWaitsOnHuman, type Data } from './store'
import { showMenu, toast, type MenuItem } from './ui/menu'
import { getUi, setUi } from './ui/state'
import type { Agent, PlainShell, Thread, UploadFile } from './types'
import { choiceOf, defaultView, keyFor, swapForDefault, type AgentViewChoice } from './views/agent-view-choice'
import { doneFocus } from './mail/mailFocus'
import { inboxOrder } from './mail/inbox-order'
import { showTab } from './sidebar-panes'

// Each agent has its own world in main: usually just its terminal, plus the tabs the
// user adds there.
// Selecting it opens its default view (agent-view-choice.ts) in place of the other one.
export function selectAgent(id: string, { asDefault = true } = {}) {
  doneFocus() // going elsewhere ends a mail link's ask (S-415)
  shell.showAgentWorld(id)
  followTree()
  if (asDefault) {
    const s = swapForDefault(shell.tabsIn(), id, defaultView(byId(id), getData().agentView))
    if (s) shell.swap(s.key, s.with)
  }
  const shown = shell.tabsIn().includes('view:' + id) && !shell.tabsIn().includes('agent:' + id) ? 'view:' + id : 'agent:' + id
  shell.autoFocus(shown)
}
// The switch: shows an agent's other view in place of the one a pane shows.
// Works in the world on screen when it shows the agent (beside another, say), else in the
// agent's own world.
export function showView(id: string, v: AgentViewChoice) {
  doneFocus()
  const want = keyFor(id, v)
  const other = keyFor(id, v === 'terminal' ? 'conversation' : 'terminal')
  if (!shell.isOpen(want) && !shell.isOpen(other)) selectAgent(id, { asDefault: false })
  if (!shell.isOpen(want) && shell.isOpen(other)) shell.swap(other, want)
  shell.open('main', want)
}
// The switch: shows the view the human picked and remembers it, so selecting the agent
// later opens that one again (Settings' default stays for agents never switched).
export function chooseView(id: string, v: AgentViewChoice) {
  showView(id, v)
  const a = byId(id)
  if (a && a.default_view !== v) void setDefaultView(a, v)
}
// A view the daemon refuses gives way to the terminal, in every world that shows it, not
// only the one on screen: a refusal can arrive while another world shows.
export function fallBackToTerminal(id: string) {
  moveDraft('view:' + id, 'agent:' + id)
  for (const world of shell.worldsWith('view:' + id)) shell.swap('view:' + id, 'agent:' + id, world)
}
// The view an agent opens in, on the daemon the browser reaches; null follows Settings.
export async function setDefaultView(a: Agent, v: AgentViewChoice | null) {
  setData({ agents: getData().agents.map((x) => (x.id === a.id ? { ...x, default_view: v } : x)) })
  try { await api('PUT', `/api/agents/${a.id}/default-view`, { view: v }) } catch (e) { toast((e as Error).message, true) }
  refresh()
}
export const openAgent = selectAgent
// Shows another agent beside the current world's agent.
export function openBeside(id: string) {
  if (!shell.currentWorld()) return selectAgent(id)
  if (shell.isOpen('agent:' + id)) shell.close('agent:' + id)
  shell.open('main', 'agent:' + id, { split: 'right' })
}
// Opens a view of an agent (its details or inbox) as a tab in its own world.
export function openFor(id: string, key: string) { if (shell.currentWorld() !== id) selectAgent(id, { asDefault: !choiceOf(key) }); shell.open('main', key) }
export const openInbox = (id: string) => openFor(id, 'mail:' + id)
// Settings, usage, the Work page, the system view, and the process view are worlds of their own, like an agent's or a thread's.
// The Inbox, Work and Agents pages open through here too: the nav bar's icons and the sidebar's tab headers (S-1428).
export const openWorld = (name: 'config' | 'inventory' | 'usage' | 'work' | 'system' | 'process' | 'swipe' | 'files' | 'inbox' | 'agents') => {
  // Mail opens in the sidebar when the setting says so (S-2310); a sidebar without a Mail tab keeps the page.
  if (name === 'inbox' && mailInSidebar() && showTab('mail')) {
    if (!shell.worldOpen('left')) shell.toggleWorld('left', true)
    return
  }
  doneFocus()
  shell.showAgentWorld('w:' + name)
  if (name === 'inbox') focusInboxList()
}
// Mail on a phone is the Inbox page, full width, as Work is: the bottom bar's Mail and every entry that used to open the mail list.
// The world Mail covers is remembered, so the phone's Main button returns to it, as the drawer left main as it was.
let beforeMail: string | null = null
export function openMail() {
  const cw = shell.currentWorld()
  if (cw !== 'w:inbox') beforeMail = cw
  shell.phoneShow(null)
  openWorld('inbox')
}
// Main leaves the page for the world it covered, or, after a reload (none remembered), the home world.
export function leaveMail() {
  if (shell.currentWorld() === 'w:inbox') shell.showAgentWorld(beforeMail)
  beforeMail = null
}

// Where Mail opens on the desktop: the sidebar's Mail tab (settings.mailOpens, S-2310). A phone always shows its Mail view.
const mailInSidebar = () => !shell.isPhone() && getData().mailOpens === 'sidebar'
// An agent type's page, `w:type:NAME`.
export const openType = (name: string) => { doneFocus(); shell.showAgentWorld('w:type:' + name) }
// An issue's own world, `w:itsa:ID`, as Settings and Usage are worlds of their own.
export const selectIssue = (id: string) => { doneFocus(); shell.showAgentWorld('w:itsa:' + id) }
// The mail the user has open, and the one before it: after an archive, "next" follows the way the user is
// moving through the list (working bottom up, the one above).
let shownMail: string | null = null
let priorMail: string | null = null
// The thread the Swipe view opened (S-1003): archiving or deferring it returns to the Swipe view.
let fromSwipe: string | null = null
export function selectThread(tid: string | null | undefined) {
  if (!tid) return
  fromSwipe = null
  if (tid !== shownMail) { priorMail = shownMail; shownMail = tid }
  // The thread takes the page: the assistant's overlay closes, since its conversation may be where the link was (S-378).
  openAssistant(false)
  shell.showAgentWorld('t:' + tid)
}

// The Inbox page (`w:inbox`, S-2054) opens a thread in one pane to the list's right: the first
// opens it as a split, and each later one takes that pane's place, so splits never stack. On a
// phone there is one pane at a time, so the thread is pushed as the world `t:ID` and back returns.
const inboxPanes = () => {
  const ls = shell.leaves(shell.mainWorld().root)
  const list = ls.find((l) => l.tabs.includes('inbox'))
  return { list, right: ls.find((l) => l !== list && l.tabs.some((k) => k.startsWith('thread:'))) }
}
// The thread showing in the Inbox page's pane, if any.
export const inboxThread = (): string | null => {
  const a = inboxPanes().right?.active
  return a?.startsWith('thread:') ? a.slice(7) : null
}
// A phone shows the world's focused pane alone, and the layout is shared with the desktop, where a thread's pane
// takes focus: the phone puts the list's pane back in front, so the page opens, and returns, as a list.
// A thread left open after its list was closed (S-2310) gets the list back, to its left, when the page opens.
function focusInboxList() {
  const { list, right } = inboxPanes()
  if (!shell.isPhone() && !list && right) { shell.open('main', 'inbox', { pane: right.id, split: 'left' }); return }
  if (shell.isPhone() && list && shell.mainWorld().focused !== list.id) shell.setFocus('main', list.id)
}
// The saved queue: the rows as the list showed them when a thread opened, each with its state then. Advancing walks
// it, so opening a thread can drop it from the list (Unread marks it read) or the chip can change, and the queue stays.
type Queue = { order: string[]; from: Map<string, string> }
let queue: Queue = { order: [], from: new Map() }
const snapshot = (order: string[]): Queue => ({ order, from: new Map(order.map((t) => [t, stateOf(t)])) })
export function openInboxThread(tid: string) {
  const onPage = shell.currentWorld() === 'w:inbox'
  // The rows as the page listed them, for advancing: on the phone too, so the Unread chip's rows stay put once read.
  if (onPage) queue = snapshot(inboxOrder())
  if (shell.isPhone() || !onPage) {
    if (onPage) focusInboxList()
    return selectThread(tid)
  }
  showInboxThread(tid)
}
// Shows a thread in the Inbox page's pane, without taking a new queue.
function showInboxThread(tid: string) {
  if (tid !== shownMail) { priorMail = shownMail; shownMail = tid }
  openAssistant(false)
  const key = 'thread:' + tid
  const { list, right } = inboxPanes()
  const has = shell.leaves(shell.mainWorld().root).find((l) => l.tabs.includes(key))
  if (right) {
    const old = right.tabs.filter((k) => k.startsWith('thread:') && k !== key)
    if (has === right) shell.activate('main', right.id, key)
    // The thread's tab was moved elsewhere (into the list's pane, say): it comes back into the reusable pane.
    else if (has) shell.move(key, 'main', right.id, null)
    else shell.open('main', key, { pane: right.id })
    for (const k of old) shell.close(k)
  } else if (has && list) shell.move(key, 'main', list.id, null, 'right')
  else shell.open('main', key, { pane: list?.id, split: 'right' })
}
// In the Inbox page, the thread after `tid` in the list as shown (its chip, search and groups), else in the inbox:
// opens it in the pane and returns true; false when none is left.
export function advanceInbox(tid: string): boolean {
  const { saved, shown } = queuedRows(tid)
  const next = nextMail(shown.includes(tid) ? shown.map((t) => ({ thread_id: t })) : mailOrder(getData()), tid, priorMail)
  if (!next) return false
  showInboxThread(next)
  // `tid` is leaving the list (archived or deferred right after this): the queue drops it, and the rest waits for the next advance.
  queue = { order: saved.order.filter((t) => t !== tid), from: saved.from }
  return true
}
// The saved queue minus the rows completed since it was taken: a row archived or deferred since (here, or in
// another pane) is passed over. A thread the queue doesn't hold walks the list as it is now.
function queuedRows(tid: string): { saved: Queue; shown: string[] } {
  const saved = queue.order.includes(tid) ? queue : snapshot(inboxOrder())
  return { saved, shown: saved.order.filter((t) => t === tid || saved.from.get(t) === stateOf(t)) }
}
// Closes the Inbox page's thread pane (nothing is left to open next).
function closeInboxThread() {
  for (const k of inboxPanes().right?.tabs ?? []) shell.close(k)
}
// The Inbox page's keys (S-2189). `j` and `k` open the row below or above the open one, in the list as shown;
// with none open, the first or the last.
export function stepInbox(dir: 1 | -1) {
  const order = inboxOrder()
  const cur = inboxThread()
  const i = cur ? order.indexOf(cur) : -1
  const next = i < 0 ? (dir > 0 ? order[0] : order.at(-1)) : order[i + dir]
  if (next !== undefined) openInboxThread(next)
}
const stateOf = (tid: string) => (isArchivedThread(tid) ? 'archived' : isDeferredThread(tid) ? 'deferred' : 'inbox')
// The newest triage the keys made (archive, defer or unread), recorded when the key is pressed: `sent` is its request and
// `undo` puts it back. Only the newest counts, so an older request's answer never replaces it.
let lastTriage: { tid: string; sent: Promise<unknown>; undo: () => Promise<unknown> } | null = null
// `e` archives and `d` defers the open thread: as the row's buttons do, the next row opens. On the Archived or
// Deferred list the same key restores the thread, as the header's button does.
export function triageInboxThread(tid: string, verb: 'archive' | 'defer'): Promise<void> {
  const from = stateOf(tid)
  const sent = verb === 'archive' ? toggleThreadArchived(tid) : toggleThreadDeferred(tid)
  lastTriage = { tid, sent, undo: () => undoMove(tid, from) }
  return sent
}
// Puts a thread back in the state it was in before `e` or `d`: where it came from, and it opens again when it returns to
// the list, if the Inbox page still shows.
async function undoMove(tid: string, from: string) {
  const now = stateOf(tid)
  if (now === from) return
  if (from === 'inbox') {
    if (now === 'archived') await setThreadArchived(tid, false)
    else await setThreadDeferred(tid, false)
    if (shell.currentWorld() === 'w:inbox') openInboxThread(tid)
  } else if (from === 'archived') await setThreadArchived(tid, true)
  else await setThreadDeferred(tid, true)
}
// `u` toggles the open thread's unread state (S-2246): a thread with unread mail for the human is marked read, and one
// without is marked unread at its latest mail to the human. The rows and counts change at once.
export function toggleInboxUnread(tid: string): Promise<void> {
  const d = getData()
  const mails = [...d.humanThreads, ...d.humanArchived, ...d.humanDeferred].find((t) => t.thread_id === tid)?.mails.filter((m) => m.recipients.some((r) => r.id === 'human')) ?? []
  const unread = mails.filter((m) => m.recipients.some((r) => r.id === 'human' && !r.read_at)).map((m) => m.id)
  const latest = mails.at(-1)?.id
  if (!unread.length && !latest) return Promise.resolve()
  const sent = unread.length ? markMailRead(unread) : markThreadUnread(tid, [latest!])
  lastTriage = { tid, sent, undo: () => (unread.length ? markThreadUnread(tid, unread) : markMailRead([latest!])) }
  return sent.then(() => undefined)
}
// `z`: undoes the newest triage, `e`, `d` or `u`. It waits for that request first, so the server sees the two in order;
// a request that failed leaves nothing to undo.
export async function undoInboxTriage() {
  const l = lastTriage
  if (!l) return
  lastTriage = null
  await l.sent
  await l.undo()
}

// The human's threads the list counts as unread: the threads in the inbox, not the archive or the deferred ones.
const unreadIn = (threads: Thread[]) => threads.reduce((n, t) => n + t.mails.filter((m) => m.recipients.some((r) => r.id === 'human' && !r.read_at)).length, 0)
// The overlays for mail: a thread moves between the inbox, the archive and the deferred ones, or the human's mail
// in some threads is marked read. Both apply at once, over the polled threads.
const moveThread = (tid: string, to: 'inbox' | 'archived' | 'deferred') => (d: Data): Data => {
  const t = [...d.humanThreads, ...d.humanArchived, ...d.humanDeferred].find((x) => x.thread_id === tid)
  if (!t) return d
  const without = (l: Thread[]) => l.filter((x) => x !== t)
  const humanThreads = to === 'inbox' ? [...without(d.humanThreads), t].sort((a, b) => b.mails.at(-1)!.created_at.localeCompare(a.mails.at(-1)!.created_at)) : without(d.humanThreads)
  const humanArchived = to === 'archived' ? [t, ...without(d.humanArchived)] : without(d.humanArchived)
  const humanDeferred = to === 'deferred' ? [t, ...without(d.humanDeferred)] : without(d.humanDeferred)
  return { ...d, humanThreads, humanArchived, humanDeferred, unread: unreadIn(humanThreads) }
}
// Only a thread's latest move applies: an undo sent before the next poll settles against the
// stale poll at once and drops, and the earlier move's overlay must not keep hiding the thread (S-1003).
const latestMove = new Map<string, number>()
let moves = 0
const moveLatest = (tid: string, to: 'inbox' | 'archived' | 'deferred') => {
  const n = ++moves
  latestMove.set(tid, n)
  const move = moveThread(tid, to)
  return (d: Data): Data => (latestMove.get(tid) === n ? move(d) : d)
}
const markRead = (ids: string[], at: string) => (d: Data): Data => {
  const mark = (t: Thread): Thread => t.mails.some((m) => ids.includes(m.id)) ? { ...t, mails: t.mails.map((m) => ids.includes(m.id)
    ? { ...m, recipients: m.recipients.map((r) => (r.id === 'human' && !r.read_at ? { ...r, read_at: at } : r)) } : m) } : t
  const humanThreads = d.humanThreads.map(mark)
  return { ...d, humanThreads, humanArchived: d.humanArchived.map(mark), humanDeferred: d.humanDeferred.map(mark), unread: unreadIn(humanThreads) }
}
const markUnread = (ids: string[]) => (d: Data): Data => {
  const mark = (t: Thread): Thread => t.mails.some((m) => ids.includes(m.id)) ? { ...t, mails: t.mails.map((m) => ids.includes(m.id)
    ? { ...m, recipients: m.recipients.map((r) => (r.id === 'human' && r.read_at ? { ...r, read_at: null } : r)) } : m) } : t
  const humanThreads = d.humanThreads.map(mark)
  return { ...d, humanThreads, humanArchived: d.humanArchived.map(mark), humanDeferred: d.humanDeferred.map(mark), unread: unreadIn(humanThreads) }
}
const isRead = (p: Data, id: string) => [...p.humanThreads, ...p.humanArchived, ...p.humanDeferred].some((t) => t.mails.some((m) => m.id === id && m.recipients.some((r) => r.id === 'human' && !!r.read_at)))

// Archiving hides a thread from the human's mail list, without deleting it; a new mail in
// the thread brings it back. The row leaves the list at once; the daemon's answer follows.
// `answered` is an archive the human's own answer or reply caused: the client's waiting lists may
// not have caught up with that answer yet, so they don't block it. The daemon still refuses an
// archive of a thread with an open decision or request.
export function setThreadArchived(tid: string, archived: boolean, answered = false): Promise<boolean> {
  // A thread waiting on the human's answer stays: a request, an ITSA's ask, or a decision (S-311, S-352).
  if (archived && !answered && threadWaitsOnHuman(tid)) { toast('Answer what waits on you before archiving', true); return Promise.resolve(false) }
  return optimistic({
    apply: moveLatest(tid, archived ? 'archived' : 'inbox'),
    send: async () => { await api('POST', `/api/agents/human/threads/${tid}/${archived ? 'archive' : 'unarchive'}`); void refreshSlow() },
    settled: (p) => p.humanArchived.some((t) => t.thread_id === tid) === archived,
    failed: archived ? "Couldn't archive" : "Couldn't unarchive",
  })
}
// The human's mail that `u` marked unread, by thread. A thread view that is showing one doesn't read it again when its
// reload sees it unread (ThreadView); the entry goes when the thread view opens again, or the mail is read.
export const keptUnread = new Map<string, Set<string>>()
// Marks the human's mail read as the thread opens: the rows stop being unread at once.
export function markMailRead(ids: string[]): Promise<boolean> {
  const at = new Date().toISOString()
  for (const kept of keptUnread.values()) for (const id of ids) kept.delete(id)
  return optimistic({
    apply: markRead(ids, at),
    send: async () => { await api('POST', '/api/agents/human/read', { ids }); void refreshSlow() },
    settled: (p) => ids.every((id) => isRead(p, id)),
    failed: "Couldn't mark read",
  })
}
// Marks the human's copies of these mail unread again (`u`, S-2246): the rows count them at once.
export function markThreadUnread(tid: string, ids: string[]): Promise<boolean> {
  keptUnread.set(tid, new Set([...(keptUnread.get(tid) ?? []), ...ids]))
  return optimistic({
    apply: markUnread(ids),
    send: async () => { await api('POST', `/api/agents/human/threads/${tid}/unread`, { ids }); void refreshSlow() },
    settled: (p) => ids.every((id) => !isRead(p, id)),
    failed: "Couldn't mark unread",
  })
}
// The mail list in the order the inbox shows it: permission requests first, then the rest.
export function mailOrder(d = getData()) {
  return [...d.humanThreads.filter(hasPendingPermission), ...d.humanThreads.filter((t) => !hasPendingPermission(t))]
}
// The mail to open after `tid` leaves the list: the one above when the user came to it from below,
// else the one below; at either end, the other neighbour; null when none is left.
export function nextMail(list: { thread_id: string }[], tid: string, prior: string | null): string | null {
  const i = list.findIndex((t) => t.thread_id === tid)
  if (i < 0) return null
  const p = prior ? list.findIndex((t) => t.thread_id === prior) : -1
  const order = p > i ? [i - 1, i + 1] : [i + 1, i - 1]
  const at = order.find((j) => j >= 0 && j < list.length)
  return at === undefined ? null : list[at].thread_id
}
// Archives the open thread and opens the next mail at once, without waiting for the daemon;
// the archive follows. An empty list shows the inbox. What the row button, the thread's header
// button, the `e` key, and a reply do.
export async function archiveThreadAndAdvance(tid: string) {
  advanceFrom(tid)
  await setThreadArchived(tid, true, true)
}
// Opens a thread from the Swipe view; archiving or deferring it there goes back to the stack.
export function openFromSwipe(tid: string) {
  selectThread(tid)
  fromSwipe = tid
}
function advanceFrom(tid: string) {
  // In the Inbox page the next thread takes the pane to the list's right.
  if (shell.currentWorld() === 'w:inbox' && !shell.isPhone()) {
    if (!advanceInbox(tid)) { shownMail = null; closeInboxThread() }
    return
  }
  if (fromSwipe === tid) { fromSwipe = null; shownMail = null; openWorld('swipe'); return }
  // A thread closed from the Deferred list moves on within that list, as the inbox does within its own.
  const d = getData()
  // On the phone, the Inbox page's rows as the list showed them when this thread opened (a pushed thread leaves the list
  // under it, and the queue walks as the desktop's does). The desktop keeps the mail order.
  const page = shell.isPhone() ? queuedRows(tid) : null
  const shown = page?.shown ?? []
  const list = d.humanDeferred.some((t) => t.thread_id === tid) ? d.humanDeferred : shown.includes(tid) ? shown.map((t) => ({ thread_id: t })) : mailOrder(d)
  const next = nextMail(list, tid, priorMail)
  if (page && shown.includes(tid)) queue = { order: page.saved.order.filter((t) => t !== tid), from: page.saved.from }
  if (next) selectThread(next)
  else { shownMail = null; shell.showAgentWorld(null) }
}
// Defer sets a thread aside for later (S-976): it leaves the inbox and the unread count and is
// listed under Deferred; a new mail in it brings it back. An ask or decision can be deferred too (S-1068):
// it stays under To answer, unanswered. So does a pending permission request.
export function setThreadDeferred(tid: string, deferred: boolean): Promise<boolean> {
  return optimistic({
    apply: moveLatest(tid, deferred ? 'deferred' : 'inbox'),
    send: async () => { await api('POST', `/api/agents/human/threads/${tid}/${deferred ? 'defer' : 'undefer'}`); void refreshSlow() },
    settled: (p) => p.humanDeferred.some((t) => t.thread_id === tid) === deferred,
    failed: deferred ? "Couldn't defer" : "Couldn't undefer",
  })
}
// Defers the open thread and opens the next mail at once, as archiveThreadAndAdvance does.
export async function deferThreadAndAdvance(tid: string) {
  advanceFrom(tid)
  await setThreadDeferred(tid, true)
}
// The header button and the phone menu: defer an open thread, or move a deferred one back to the inbox.
export async function toggleThreadDeferred(tid: string) {
  if (isDeferredThread(tid)) await setThreadDeferred(tid, false)
  else await deferThreadAndAdvance(tid)
}
// The header button, the phone menu, and the `e` key: archive an open thread, or unarchive one
// archive hides. A thread waiting on the human's answer stays (threadWaitsOnHuman).
export async function toggleThreadArchived(tid: string) {
  if (isArchivedThread(tid)) await setThreadArchived(tid, false)
  else if (threadWaitsOnHuman(tid)) toast('Answer what waits on you before archiving', true)
  else await archiveThreadAndAdvance(tid)
}

// A plain terminal: a shell in tmux on the agent's machine, in its folder.
export async function newShell(a?: Agent) {
  try {
    const sh = await api<PlainShell>('POST', '/api/shells', a ? { cwd: a.cwd, machine: a.machine } : {})
    setData({ shells: [...getData().shells, sh] })
    shell.open('main', `shell:${sh.machine}:${sh.id}`)
  } catch (e) { toast((e as Error).message, true) }
}

// An agent's change, shown at once: the tree node shows `pending` (what it is doing) and `patch`
// applies over the agent, until a poll agrees (`settled`) or the request fails.
function agentChange(a: Agent, c: { pending: string; patch?: Partial<Agent>; settled: (p?: Agent) => boolean; send: () => Promise<unknown>; failed: string }): Promise<boolean> {
  return optimistic({
    apply: (d) => ({ ...d, agents: d.agents.map((x) => (x.id === a.id ? { ...x, ...c.patch, pending: c.pending } : x)) }),
    send: c.send,
    settled: (p) => c.settled(p.agents.find((x) => x.id === a.id)),
    failed: c.failed,
  })
}

// The lifecycle an action moves an agent to, as the tree shows it while the change is in flight.
// An action without a state to wait for (restart, compact) settles when its request succeeds.
const settledNow = () => true
const ACTION_PENDING: Record<string, { pending: string; settled: (a: Agent, p?: Agent) => boolean }> = {
  pause: { pending: 'pausing', settled: (_, p) => p?.lifecycle === 'paused' },
  unpause: { pending: 'unpausing', settled: (_, p) => !!p && p.lifecycle !== 'paused' },
  shutdown: { pending: 'shutting down', settled: (a, p) => !p || p.lifecycle !== a.lifecycle },
  archive: { pending: 'archiving', settled: (a, p) => !p || p.lifecycle !== a.lifecycle },
  resume: { pending: 'resuming', settled: (a, p) => !!p && p.lifecycle !== a.lifecycle },
  restart: { pending: 'restarting', settled: settledNow },
  compact: { pending: 'compacting', settled: settledNow },
  'reconnect-mcp': { pending: 'reconnecting', settled: settledNow },
}

// 'settings' makes the agent follow Settings › Permission modes again; the others are its own pick.
export async function setMode(a: Agent, mode: 'auto' | 'bypass' | 'default' | 'settings') {
  const to = mode === 'bypass' ? 'bypass permissions: it runs every action without asking' : mode === 'default' ? 'ask mode: the harness asks before each action' : mode === 'settings' ? 'the mode Settings give it' : 'auto mode'
  if (!confirm(`Switch ${a.name} to ${to}? It restarts after its current step.`)) return false
  await agentChange(a, {
    pending: 'switching mode', patch: mode === 'settings' ? { permission_source: 'settings' } : { permission_mode: mode, permission_source: 'manual' }, settled: (p) => (mode === 'settings' ? followsSettings(p ?? {}) : p?.permission_mode === mode),
    send: () => api('POST', `/api/agents/${a.id}/permission-mode`, { mode }).then(() => refresh()), failed: "Couldn't switch the mode",
  })
  return true
}

export async function setChildNotices(a: Agent, value: string) {
  await agentChange(a, {
    pending: 'saving notices', patch: { child_notices: value }, settled: (p) => p?.child_notices === value,
    send: () => api('POST', `/api/agents/${a.id}/set-child-notices`, { child_notices: value }).then(() => refresh()), failed: "Couldn't set child notices",
  })
}

export async function agentAction(a: Agent, action: string, done?: string) {
  const p = ACTION_PENDING[action] ?? { pending: action, settled: settledNow }
  await agentChange(a, {
    pending: p.pending, settled: (x) => p.settled(a, x), failed: `Couldn't ${action.replace(/-/g, ' ')}`,
    send: async () => {
      const r = await api<{ result?: string }>('POST', `/api/agents/${a.id}/${action}`)
      toast(`${a.name}: ${r.result ?? done ?? action}`)
      refresh()
    },
  })
}

export function agentMenu(a: Agent | undefined): MenuItem[] {
  if (!a) return []
  const act = (action: string) => () => agentAction(a, action)
  const cw = shell.currentWorld()
  const items: MenuItem[] = [{ section: a.name },
    { label: 'Open its world', icon: 'terminal', action: () => selectAgent(a.id) },
    ...(cw && cw !== a.id ? [{ label: `Show beside ${byId(cw)?.name ?? 'this one'}`, icon: 'columns-2', action: () => openBeside(a.id) }] : []),
    { label: 'New terminal in its folder', icon: 'terminal', action: () => newShell(a) },
    ...(live(a) ? [treeItem(a)] : []),
    ...(a.view ? [shell.isOpen('view:' + a.id) && !shell.isOpen('agent:' + a.id)
      ? { label: 'Show its terminal', icon: 'terminal', action: () => chooseView(a.id, 'terminal') }
      : { label: 'Show its conversation', icon: 'message-square', action: () => chooseView(a.id, 'conversation') }] : []),
    { label: 'Details', icon: 'info', action: () => openFor(a.id, 'details:' + a.id) },
    { label: 'Instructions', icon: 'file-text', action: () => openFor(a.id, 'instructions:' + a.id) },
    { label: 'Inventory', icon: 'layers', action: () => openFor(a.id, 'inventory:' + a.id) },
    ...(a.type ? [{ label: `The ${a.type} type`, icon: 'layers', action: () => openType(a.type!) }] : []),
    { label: 'Inbox', icon: 'inbox', action: () => openInbox(a.id) }]
  if (live(a)) {
    items.push({ label: 'Add child agent…', icon: 'plus', action: (r) => spawnMenu(r.left, r.top, { parent: a.id }) }, 'sep',
      a.lifecycle === 'paused' ? { label: 'Unpause', icon: 'play', action: act('unpause') } : { label: 'Pause', icon: 'pause', action: act('pause') },
      { label: 'Restart', icon: 'rotate-ccw', action: act('restart') },
      { label: 'Compact context', icon: 'minimize-2', action: act('compact') },
      { label: 'Reconnect MCP', icon: 'plug', action: act('reconnect-mcp') },
      { label: a.permission_mode === 'bypass' ? 'Switch to auto mode' : 'Switch to bypass permissions', icon: 'zap', action: () => setMode(a, a.permission_mode === 'bypass' ? 'auto' : 'bypass') },
      'sep',
      { label: 'Shut down', icon: 'power', action: act('shutdown') },
      { label: 'Archive', icon: 'archive', action: () => { if (confirm(`Archive ${a.name}? It shuts down, and a worktree it owns is removed (its branch stays).`)) act('archive')() } },
      { label: 'Stop now', icon: 'x', danger: true, action: () => { if (confirm(`Stop ${a.name} now? Its harness quits, even mid-turn.`)) api('POST', `/api/agents/${a.id}/kill`).then(refresh, (e) => toast(e.message, true)) } })
  } else {
    items.push('sep', { label: 'Resume', icon: 'play', action: act('resume') },
      { label: 'Forget', icon: 'trash-2', danger: true, action: () => { if (confirm(`Forget ${a.name}? It leaves the registry with its mailbox and events.`)) api('POST', `/api/agents/${a.id}/forget`).then(() => { shell.dropAgentWorld(a.id); shell.close('agent:' + a.id); refresh() }, (e) => toast(e.message, true)) } })
  }
  return items
}

// --- The tree view ------------------------------------------------------------------
// A mode of an agent's world that shows its whole subtree. The agent takes half; its
// children share the other half; each nesting level alternates between side by side and
// stacked. While the mode is on, the layout follows the tree as agents come and go. The
// agent's own pane, with any tabs added to it, is the same pane in and out of the mode;
// the world's normal layout waits in `saved`.
function treeLayout(id: string, dir: shell.Dir, mainPane: shell.Leaf | undefined, seen = new Set<string>()): shell.Node {
  seen.add(id)
  const pane = mainPane ?? shell.leaf(['agent:' + id])
  const kids = childrenOf(id).filter((x) => !seen.has(x.id))
  if (!kids.length) return pane
  for (const k of kids) seen.add(k.id)
  const next: shell.Dir = dir === 'row' ? 'col' : 'row'
  const subs = kids.map((k) => { seen.delete(k.id); return treeLayout(k.id, next, undefined, seen) })
  return shell.split(dir, [pane, subs.length === 1 ? subs[0] : shell.split(next, subs)])
}
function treeSig(id: string, seen = new Set<string>()): string {
  seen.add(id)
  const kids = childrenOf(id).filter((x) => !seen.has(x.id))
  return id + '(' + kids.map((k) => treeSig(k.id, seen)).join(',') + ')'
}
// The pane that shows the world's own agent.
function mainPaneOf(w: shell.World, id: string) {
  const all = [...shell.leaves(w.root), ...(w.saved ? shell.leaves(w.saved) : [])]
  return all.find((l) => l.id === w.mainPane) ?? all.find((l) => l.tabs.includes('agent:' + id) || l.tabs.includes('view:' + id))
}
export function enterTree(dir: shell.Dir) {
  const id = shell.currentWorld()
  if (!byId(id)) return toast('Pick an agent first.')
  const w = shell.mainWorld()
  if (w.tree === dir) return exitTree()
  if (!w.tree) w.saved = w.root
  const main = mainPaneOf(w, id!) ?? shell.leaf(['agent:' + id])
  w.mainPane = main.id
  w.tree = dir
  buildTree()
}
function buildTree() {
  const id = shell.currentWorld()
  const w = shell.mainWorld()
  if (!w.tree || !id || !byId(id)) return
  w.treeSig = treeSig(id)
  shell.setLayout(treeLayout(id, w.tree, mainPaneOf(w, id)), 'agent:' + id)
}
export function exitTree() {
  const id = shell.currentWorld()
  const w = shell.mainWorld()
  if (!w.tree || !id) return
  const main = mainPaneOf(w, id)
  let root: shell.Node = w.saved ?? main ?? shell.leaf(['agent:' + id])
  // The saved layout gets the agent's pane as it is now, with its tabs.
  if (main && w.saved) {
    const swap = (n: shell.Node): shell.Node => (n.id === main.id ? main : n.split ? { ...n, children: n.children.map(swap) } : n)
    root = swap(w.saved)
    if (!shell.leaves(root).includes(main)) root = main
  }
  delete w.saved; delete w.tree; delete w.treeSig
  shell.setLayout(root, 'agent:' + id)
}
// Keeps the current world's tree view in step with the agent tree.
export function followTree() {
  const id = shell.currentWorld()
  const w = id && shell.mainWorld()
  if (w && w.tree && w.treeSig !== treeSig(id)) buildTree()
}
export const inTreeView = (id: string) => shell.currentWorld() === id && !!shell.mainWorld().tree
// "Show its children": the tree view, to the right or below, from a submenu.
export function treeItem(a: Agent): MenuItem {
  const has = childrenOf(a.id).length > 0
  if (inTreeView(a.id)) return { label: 'Leave the tree view', icon: 'network', hint: 'Alt+0', action: exitTree }
  return { label: 'Show its children…', icon: 'network', disabled: !has, action: (r) => showMenu(r.left, r.top, [{ section: `${a.name}'s children` },
    { label: 'To the right', icon: 'columns-2', hint: 'Alt+1', action: () => { selectAgent(a.id); enterTree('row') } },
    { label: 'Below', icon: 'rows-2', hint: 'Alt+2', action: () => { selectAgent(a.id); enterTree('col') } }]) }
}

// The agent whose terminal a pane shows, if it shows one.
export function paneAgent(pane: string) {
  const key = shell.paneActive(pane)
  return key?.startsWith('agent:') ? key.slice(6) : null
}

// --- Permission requests ------------------------------------------------------------
// The note reaches the agent with the answer; approving with none says "I authorize".
export async function answerPermission(id: string, approve: boolean, note = '', client_id?: string) {
  // A suggested input (S-422) is approved on its card, which sends the hash of the text shown.
  if (approve && getData().perms.some((p) => p.id === id && p.kind === 'input')) throw new Error('Approve a suggested input on its card, where its text is shown')
  await api('POST', `/api/permissions/${id}/answer`, { approve, note: note || (approve ? 'I authorize' : ''), client_id, machine: getData().perms.find((p) => p.id === id)?.machine })
  refresh()
  refreshSlow()
}

// --- The executive assistant ----------------------------------------------------------
// What the human has in front of them, so the assistant knows what "this" means.
export function viewContext() {
  const key = shell.activeIn('main') ?? ''
  const a = byId(key.split(':')[1])
  if (key.startsWith('agent:') && a) return `${a.name} (${a.id}), an agent's terminal`
  if (key.startsWith('view:') && a) return `${a.name} (${a.id}), mootr's view of an agent's conversation`
  if (key.startsWith('shell:')) return 'a plain terminal'
  if (key.startsWith('thread:')) { const tid = key.slice(7); const t = getData().humanThreads.find((x) => x.thread_id === tid); return `the mail thread "${plainSubject(t?.mails[0].subject ?? '')}" (thread ${tid})` }
  if (key.startsWith('mail:') && a) return `${a.name}'s inbox`
  if (key.startsWith('details:') && a) return `${a.name}'s details`
  if (key.startsWith('instructions:') && a) return `${a.name}'s instructions`
  if (key.startsWith('inventory:') && a) return `${a.name}'s inventory`
  if (key.startsWith('itsa:')) { const x = getData().itsas.find((i) => i.id === key.slice(5)); return x ? `the ITSA ${x.key} "${x.title}" (${x.id})` : 'an ITSA' }
  if (key === 'config') return 'the settings'
  if (key === 'usage') return 'the usage page'
  if (key === 'process') return 'the process view'
  return 'nothing in particular'
}
// `extra`: more fields for the message, such as the suggestion prompts' `routing_uncertain` and `looking_at`;
// with `looking_at`, the server's note says what the main world showed, so `context` is left out.
export async function sendToAssistant({ text, files, client_id }: { text: string; files: UploadFile[]; client_id?: string }, extra?: Record<string, unknown>) {
  const had = assistant()
  await api('POST', '/api/assistant/message', { text, files, ...(extra?.looking_at ? {} : { context: viewContext() }), ...extra, client_id })
  await refresh()
  return had ? 'Sent to your assistant' : 'Your assistant is starting with your message'
}
export function AssistantLabel() {
  const a = assistant()
  return <>{a ? <Glyph agent={a} /> : <PlainGlyph name="bot" />}<b>Assistant</b><span className="muted">about {viewContext().replace(/ \(.*?\)/, '')}</span></>
}
export const assistantOpts = {
  send: sendToAssistant, label: () => <AssistantLabel />,
  // The agent choices of the recipient menu (parent, intake, cos) are written to by mail.
  to: (a: Agent) => ({ id: a.id, name: a.name, glyph: <Glyph agent={a} />, label: <><Glyph agent={a} /><b>{a.name}</b><span className="muted">by mail</span></>,
    placeholder: `Write to ${a.name}; it gets this as mail from you`, send: (p: { text: string; files: UploadFile[]; client_id?: string; cc?: string[] }) => sendToChief(a, p) }),
}
export function openAssistant(open = !getUi().topOpen) { setUi(open ? { topOpen: true, suggestOpen: false } : { topOpen: false }) }

// --- The human's mail to an agent ------------------------------------------------------
// A thread of its own: the subject is the message's first line, so it reads as the topic in
// the human's mailbox, and the agent's answer joins the thread.
// With `itsa` (an ITSA's key), the mail is about that ITSA: the server files it on the ITSA.
// `extra`: more fields for the request body, such as the Alt+A prompt's `routing_uncertain`.
// `itsa`: the ITSA it is filed on; else the one the payload picked as a cc pill (S-1464).
async function mailAgent(a: Agent, { text, files, client_id, cc, itsa: picked }: { text: string; files: UploadFile[]; client_id?: string; cc?: string[]; itsa?: string }, itsa = picked, extra?: Record<string, unknown>) {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? (files[0]?.name ?? 'A message')
  const subject = line.length > 60 ? line.slice(0, 59).trimEnd() + '…' : line
  await api('POST', '/api/mail', { from: 'human', to: [...new Set([a.id, ...(cc ?? [])])], subject, new_thread: true, body: text, attachments: files.map((f) => ({ name: f.name, content_b64: f.content_b64 })), ...(itsa ? { itsa } : {}), ...extra, client_id })
  refreshSlow()
  return `Mailed ${a.name}${cc?.length ? ` and ${cc.length} more` : ''}; the answer comes to your mail`
}
// The prompt input's Mail mode: the message goes to the agent as mail from the human
// instead of into its terminal.
export const sendToAgentByMail = mailAgent
// The human writes to a chief of staff by mail: it reaches it running, busy, or paused, on
// any machine, and its answer comes back as mail.
export const sendToChief = mailAgent
// What the top world can write to: the assistant, then each chief of staff.
// tag: what the agent is, under its name in the header; title: its switch button's tooltip.
export interface TopTarget { id: string; agent?: Agent; name: string; tag: string; title: string; send: (p: { text: string; files: UploadFile[]; client_id?: string; cc?: string[] }, extra?: Record<string, unknown>) => Promise<string> }
export function topTargets(): TopTarget[] {
  return [{ id: 'assistant', agent: assistant(), name: 'Assistant', tag: '', title: 'Your executive assistant', send: sendToAssistant },
    ...chiefAssistants().map((a) => ({ id: a.id, agent: a, name: a.name, tag: "chief of staff's assistant", title: `${a.name}, chief of staff's assistant`, send: (p: { text: string; files: UploadFile[]; client_id?: string; cc?: string[] }) => sendToChief(a, p) })),
    ...chiefsOfStaff().map((a) => ({ id: a.id, agent: a, name: a.name, tag: 'chief of staff', title: `${a.name}, chief of staff`, send: (p: { text: string; files: UploadFile[]; client_id?: string; cc?: string[] }) => sendToChief(a, p) }))]
}
// The target this device picked; with no pick, or once the pick is gone, the default in Settings,
// and the executive assistant when that one is gone too.
export function topTarget(): TopTarget {
  const all = topTargets()
  const dflt = getData().assistantDefault
  const byDefault = all.find((t) => (t.id === 'assistant' ? dflt === 'assistant' : t.agent?.name === dflt))
  return all.find((t) => t.id === getUi().topTarget) ?? byDefault ?? all[0]
}
export function setTopTarget(id: string) { setUi({ topTarget: id, topOpen: true, suggestOpen: false }) }
// The view the Assistant tab shows its agent in: the same default as opening the agent anywhere
// else (agent-view-choice.ts), so the tab and the agent's own world agree.
export function topView(a: Agent | undefined): AgentViewChoice { return defaultView(a, getData().agentView) }
// Alt+C: opens the top world on the target last written to, or moves it to the next one; with
// the assistant alone, it closes it again (Alt+A is the prompt that suggests a recipient, S-1461).
export function nextTopTarget() {
  const all = topTargets()
  const cur = topTarget()
  if (!getUi().topOpen) setTopTarget(cur.id)
  else if (all.length < 2) openAssistant(false)
  else setTopTarget(all[(all.findIndex((t) => t.id === cur.id) + 1) % all.length].id)
  return true
}
