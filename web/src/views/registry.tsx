// The views tabs show, by key: `agent:ID` (its terminal), `view:ID` (stam's own view of
// its conversation, OwnView.tsx), `shell:MACHINE:ID` (a plain
// terminal), `details:ID`, `instructions:ID` (what the agent gets), `inventory:ID` (the same as sized, summarized blocks), `inventory` (that for an agent type), `mail:ID` (an inbox;
// `mail:human` is the human's), `thread:ID`, `itsa:ID` (an ITSA), `image:ID` (staged images, S-1475), `req:KEY` (a requirement), `compliance` (the requirements' compliance matrix), `board:ID` and `board:all` (a board of ITSAs), `work` (the Work page), `system` (the system view), `process` (a process, read-only), `files` (the Files world) and `file:HOST:PATH[#Lline]` (one file), `diff:REPO#N` (one PR's diff, S-1531), `patch:HASH` (a patch pasted in mail, S-2103), `config` (Settings), and `usage`. Each view
// renders once into its own element, which panes adopt; a view not on screen waits, alive,
// in a hidden store.
import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { hash } from '../api'
import { baseName, parseFileKey } from '../files/fileKey'
import { diffTitle, parseDiffKey, parsePatchKey } from '../diff/diffKey'
import { readPatch } from '../diff/patchStore'
import { HARNESS, k, money, stateOf, STATE_LABEL } from '../format'
import { Glyph } from '../Glyph'
import { Icon } from '../Icon'
import { stateHelp } from '../legend'
import { destroyViewElement, leaves, mainWorld, useMadeViews, useShell, viewElement } from '../shell/layout'
import { byId, getData, useData } from '../store'
import type { Agent } from '../types'
import { clock, restText, waitLabel, waitsOf } from '../waits'
import { ConfigView } from './ConfigView'
import { DetailsView } from './DetailsView'
import { InstructionsView } from './InstructionsView'
import { ImageTabView } from './ImageTabView'
import { imageSet } from '../image-tab'
import { InventoryView, TypeInventoryView } from './InventoryView'
import { TypeView } from './TypeView'
import { ViewBoundary } from './ViewBoundary'
import { ItsaView, itsaTitles } from './ItsaView'
import { Board } from '../itsa/Board'
import { StatusGlyph } from '../itsa/itsa'
import { MailView } from './MailView'
import { TerminalView } from './TerminalView'
import { ThreadView } from './ThreadView'
import { threadHead, threadOf } from '../mail/thread-chips'
import { UsageView } from './UsageView'
import { RapidView } from './RapidView'
import { getUi, useUi } from '../ui/state'
import { WorkView } from '../work/WorkView'
import { AgentsPage } from '../AgentsPage'
import { SwipeView } from '../mail/SwipeView'
import { InboxView } from '../mail/InboxView'
import { ReqView, reqTitles } from '../req/ReqView'
import { ComplianceView } from '../req/ComplianceView'
import { findReq } from '../req/store'

// assistant-ui loads only when a conversation view opens (about 100 kB gzipped).
const OwnView = lazy(() => import('./OwnView').then((m) => ({ default: m.OwnView })))
// The system view and d3-hierarchy load when it first opens, or at once for a link that opens
// it (#view=system): then the view renders straight away, not through Suspense, whose reveal
// React holds back for a while, so its first paint follows the data (S-462). Once it has shown
// through Suspense it stays there, so it never mounts twice.
type SystemModule = typeof import('../system/SystemView')
let systemMod: SystemModule | null = null
let systemLazy = false
const loadSystem = () => import('../system/SystemView').then((m) => { systemMod = m; return { default: m.SystemView } })
const systemSoon = hash.get('view') === 'system' ? loadSystem() : null
const SystemView = lazy(() => systemSoon ?? loadSystem())
function systemView(viewKey: string): ReactNode {
  if (systemMod && !systemLazy) return <systemMod.SystemView viewKey={viewKey} />
  systemLazy = true
  return <Suspense fallback={null}><SystemView viewKey={viewKey} /></Suspense>
}

// The process view loads its own chunk (React Flow is heavy) when it first opens, or at once for a
// link that opens it (#view=process), the same way the system view does.
type ProcessModule = typeof import('../process/ProcessView')
let processMod: ProcessModule | null = null
let processLazy = false
const loadProcess = () => import('../process/ProcessView').then((m) => { processMod = m; return { default: m.ProcessView } })
const processSoon = hash.get('view') === 'process' ? loadProcess() : null
const ProcessView = lazy(() => processSoon ?? loadProcess())
function processView(viewKey: string): ReactNode {
  if (processMod && !processLazy) return <processMod.ProcessView viewKey={viewKey} />
  processLazy = true
  return <Suspense fallback={null}><ProcessView viewKey={viewKey} /></Suspense>
}

// The Files world and the file view load when one first opens (S-1526), like the process view.
const FilesView = lazy(() => import('../files/FilesView').then((m) => ({ default: m.FilesView })))
const FileView = lazy(() => import('../files/FileView').then((m) => ({ default: m.FileView })))
// The PR diff view (S-1531) loads when one first opens; its CodeMirror merge editor is a further chunk, loaded when the first file draws.
const DiffView = lazy(() => import('../diff/DiffView').then((m) => ({ default: m.DiffView })))

export function agentTooltip(a: Agent) {
  const s = stateOf(a)
  const lines = [`${a.name} · ${STATE_LABEL[s] ?? s}${a.activity_detail ? ' (' + a.activity_detail + ')' : ''}`, stateHelp(s),
    `${HARNESS[a.harness] ?? a.harness} · ${a.model ?? 'default model'}${a.effort ? ' · ' + a.effort : ''}`,
    `Context ${k(a.context_tokens)} · spent ${money(a.cost_usd ?? 0)}`, `${a.machine}: ${a.cwd}`]
  if (a.role) lines.splice(2, 0, a.role)
  if (a.resting) lines.push(restText(a.resting))
  if (a.permission_mode === 'bypass') lines.push('Bypass permissions')
  if (a.unread) lines.push(`${a.unread} unread mail`)
  if (a.pending_requests) lines.push(`${a.pending_requests} permission request waiting`)
  for (const w of waitsOf(a)) lines.push(`Waiting for ${waitLabel(w)}${w.until && w.kind !== 'timer' ? ' until ' + clock(w.until) : ''}`)
  return lines.join('\n')
}

export function validKey(key: string) {
  return /^(agent|view|details|instructions|inventory|type|mail|thread|itsa|board|req|image):.+/.test(key) || /^shell:[^:]+:.+/.test(key) || key === 'config' || key === 'inventory' || key === 'usage' || key === 'work' || key === 'system' || key === 'process' || key === 'swipe' || key === 'inbox' || key === 'agents' || key === 'compliance' || key === 'files' || /^file:[^:/]+:\/.+/.test(key) || parseDiffKey(key) !== null || parsePatchKey(key) !== null
}

// Whether a saved tab still has something to show after a reload.
export function keepKey(key: string) {
  const d = getData()
  if (key === 'details' || key === 'approvals') return false
  // A patch tab lives in this browser's LRU (S-2103): it survives a reload only while its entry does.
  if (key.startsWith('patch:')) { const h = parsePatchKey(key); return !!h && readPatch(h) !== null }
  if (key.startsWith('agent:') || key.startsWith('view:') || key.startsWith('details:') || key.startsWith('instructions:') || key.startsWith('inventory:')) return !!byId(key.slice(key.indexOf(':') + 1))
  // An image tab's pictures live in the page that opened it; the layout is shared, so a page never closes one.
  if (key.startsWith('mail:')) return key === 'mail:human' || !!byId(key.slice(5))
  if (key.startsWith('shell:')) { const [, m, id] = key.split(':'); return m !== d.machine || d.shells.some((x) => x.id === id) }
  return true
}

export interface Meta { title: string; icon: ReactNode; tooltip?: string; badge?: number | string; badgeClass?: string }
export function viewMeta(key: string): Meta {
  const d = getData()
  const id = key.slice(key.indexOf(':') + 1)
  if (key.startsWith('agent:')) {
    const a = byId(id)
    return { title: a?.name ?? id, icon: a ? <Glyph agent={a} /> : <Icon name="terminal" />, tooltip: a ? agentTooltip(a) : id, badge: a?.pending_requests || a?.unread || '', badgeClass: a?.pending_requests ? 'warn' : '' }
  }
  if (key.startsWith('shell:')) {
    const [, m, sid] = key.split(':')
    const sh = d.shells.find((x) => x.id === sid)
    return { title: 'Terminal', icon: <Icon name="terminal" />, tooltip: `Terminal on ${m} in ${sh?.cwd ?? ''}` }
  }
  if (key.startsWith('view:')) {
    const a = byId(id)
    // Its icon is the agent's state glyph, live from the view while it's open (S-205).
    if (getUi().rapid?.[id]) return { title: a?.name ?? id, icon: a ? <Glyph agent={a} /> : <Icon name="zap" />, tooltip: a ? `Your threads with ${a.name} as cards: each send starts one, or follows up in the card you pick` : id, badge: a?.pending_requests || '', badgeClass: a?.pending_requests ? 'warn' : '' }
    return { title: a?.name ?? id, icon: a ? <Glyph agent={a} /> : <Icon name="message-square" />, tooltip: a ? `${a.name}'s conversation, drawn by mootr; its terminal stays the fallback` : id, badge: a?.pending_requests || '', badgeClass: a?.pending_requests ? 'warn' : '' }
  }
  if (key.startsWith('details:')) return { title: `${byId(id)?.name ?? id} · details`, icon: <Icon name="info" /> }
  if (key.startsWith('instructions:')) return { title: `${byId(id)?.name ?? id} · instructions`, icon: <Icon name="file-text" /> }
  if (key.startsWith('inventory:')) return { title: `${byId(id)?.name ?? id} · inventory`, icon: <Icon name="layers" /> }
  if (key.startsWith('image:')) { const i = imageSet(id); const img = i?.images[i.index]; return { title: img?.alt || 'Image', icon: <Icon name="paperclip" />, tooltip: img?.alt || undefined } }
  if (key.startsWith('type:')) return { title: `${id} · type`, icon: <Icon name="layers" />, tooltip: `The ${id} agent type: instructions, agents, proposals` }
  if (key.startsWith('mail:')) {
    const human = id === 'human'
    return { title: human ? 'Your inbox' : `${byId(id)?.name ?? id}'s inbox`, icon: <Icon name="inbox" />, badge: human ? d.unread || '' : byId(id)?.unread || '' }
  }
  if (key.startsWith('thread:')) {
    // The short title (S-2311): the thread's model title, else its subject; the full subject and people go in the tooltip.
    const head = threadHead(threadOf(id, d)?.mails ?? [], d.agents)
    return { title: head.title || 'Thread', icon: <Icon name="mail" />, tooltip: head.tooltip || undefined }
  }
  if (key.startsWith('itsa:')) {
    const x = d.itsas.find((i) => i.id === id)
    return { title: (x ? `${x.key} ${x.title}` : itsaTitles.get(id)) || 'Issue', icon: x ? <StatusGlyph status={x.status} /> : <Icon name="list-checks" />, tooltip: x ? `${x.key} · ${x.title}` : undefined }
  }
  if (key.startsWith('board:')) {
    const x = d.itsas.find((i) => i.id === id)
    return { title: id === 'all' ? 'All issues' : x ? `${x.key} board` : 'Board', icon: <Icon name="kanban" />, tooltip: x ? `Board of ${x.key} · ${x.title}` : 'Board of every issue' }
  }
  if (key.startsWith('req:')) {
    const x = findReq(id)
    return { title: (x ? `${x.key} ${x.title}` : reqTitles.get(id)) || id, icon: <Icon name="scale" />, tooltip: x ? `${x.key} · ${x.title}` : undefined }
  }
  if (key === 'compliance') return { title: 'Compliance', icon: <Icon name="grid-3x3" />, tooltip: 'Each requirement\'s latest check on each subject' }
  if (key === 'work') return { title: 'Work', icon: <Icon name="layout-list" />, tooltip: 'Every open issue, grouped by issue tree' }
  if (key === 'agents') return { title: 'Agents', icon: <Icon name="users" />, tooltip: 'Every agent in its tree, live and stopped' }
  if (key === 'system') return { title: 'System', icon: <Icon name="network" />, tooltip: 'The whole system: every agent in its tree, with its work' }
  if (key === 'swipe') return { title: 'Swipe', icon: <Icon name="layers" />, tooltip: 'Your inbox as cards: left archives, right leaves, up defers' }
  if (key === 'inbox') return { title: 'Inbox', icon: <Icon name="inbox" />, tooltip: 'Your mail: filter, search, and open a thread beside the list', badge: d.unread || '' }
  if (key === 'files') return { title: 'Files', icon: <Icon name="folder" />, tooltip: 'Files on this machine and its peers' }
  if (key.startsWith('file:')) {
    const f = parseFileKey(key)
    return { title: f ? baseName(f.path) : 'File', icon: <Icon name="file-text" />, tooltip: f ? `${f.host}:${f.path}` : undefined }
  }
  if (key.startsWith('diff:')) {
    const d = parseDiffKey(key)
    return { title: d ? diffTitle(d.pr) : 'Diff', icon: <Icon name="git-pull-request" />, tooltip: d ? `${d.repo} PR #${d.pr}` : undefined }
  }
  if (key.startsWith('patch:')) {
    const h = parsePatchKey(key)
    return { title: h ? `Patch ${h}` : 'Patch', icon: <Icon name="git-pull-request" />, tooltip: 'A patch pasted in mail, opened in the diff viewer' }
  }
  if (key === 'process') return { title: 'Process', icon: <Icon name="git-branch" />, tooltip: 'A process, drawn read-only: its lanes, nodes, and live counts' }
  if (key === 'inventory') return { title: 'Inventory by type', icon: <Icon name="layers" /> }
  if (key === 'config') return { title: 'Settings', icon: <Icon name="settings" /> }
  if (key === 'usage') return { title: 'Usage', icon: <Icon name="chart-column" /> }
  return { title: key, icon: <Icon name="info" /> }
}

// An agent's conversation: stam's own view of it, or its rapid-fire mode (S-1004) where this device picked that.
function ConvView({ id, viewKey }: { id: string; viewKey: string }) {
  const { rapid } = useUi()
  return rapid?.[id] ? <RapidView id={id} /> : <Suspense fallback={null}><OwnView id={id} viewKey={viewKey} /></Suspense>
}

function UsageHosted() {
  useShell()
  const shown = leaves(mainWorld().root).some((l) => l.active === 'usage')
  return <UsageView shown={shown} />
}

// Owns a view's element for as long as its portal lives, outside the boundary: a view that
// throws unmounts below it, and its error must stay in the element it showed in.
export function ViewHost({ viewKey: key, children }: { viewKey: string; children: ReactNode }) {
  useEffect(() => () => destroyViewElement(key), [key])
  return <ViewBoundary viewKey={key}>{children}</ViewBoundary>
}

function Content({ viewKey: key }: { viewKey: string }) {
  useData()
  const id = key.slice(key.indexOf(':') + 1)
  if (key.startsWith('agent:')) return <TerminalView viewKey={key} id={id} />
  if (key.startsWith('shell:')) {
    const [, m, sid] = key.split(':')
    const sh = getData().shells.find((x) => x.id === sid) ?? { id: sid, machine: m, cwd: '' }
    return <TerminalView viewKey={key} id={sid} sh={{ ...sh, machine: m }} />
  }
  if (key.startsWith('view:')) return <ConvView id={id} viewKey={key} />
  if (key.startsWith('details:')) return <DetailsView id={id} />
  if (key.startsWith('instructions:')) return <InstructionsView id={id} />
  if (key.startsWith('inventory:')) return <InventoryView id={id} />
  if (key.startsWith('image:')) return <ImageTabView id={id} viewKey={key} />
  if (key.startsWith('type:')) return <TypeView name={id} />
  if (key.startsWith('mail:')) return <MailView owner={id} viewKey={key} />
  if (key.startsWith('thread:')) return <ThreadView tid={id} viewKey={key} />
  if (key.startsWith('itsa:')) return <ItsaView id={id} viewKey={key} />
  if (key.startsWith('board:')) return <Board id={id === 'all' ? null : id} viewKey={key} />
  if (key.startsWith('req:')) return <ReqView keyName={id} viewKey={key} />
  if (key === 'compliance') return <ComplianceView />
  if (key === 'work') return <WorkView viewKey={key} />
  if (key === 'agents') return <AgentsPage />
  if (key === 'system') return systemView(key)
  if (key === 'process') return processView(key)
  if (key === 'files') return <Suspense fallback={null}><FilesView /></Suspense>
  if (key.startsWith('file:')) return <Suspense fallback={null}><FileView viewKey={key} /></Suspense>
  if (key.startsWith('diff:') || key.startsWith('patch:')) return <Suspense fallback={null}><DiffView viewKey={key} /></Suspense>
  if (key === 'swipe') return <SwipeView />
  if (key === 'inbox') return <InboxView />
  if (key === 'inventory') return <TypeInventoryView />
  if (key === 'config') return <ConfigView />
  if (key === 'usage') return <UsageHosted />
  return null
}

export function ViewPortals() {
  const keys = useMadeViews()
  return <>{keys.map((key) => createPortal(<ViewHost viewKey={key}><Content viewKey={key} /></ViewHost>, viewElement(key), key))}</>
}

