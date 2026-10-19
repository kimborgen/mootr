// Tool calls as the conversation draws them (S-1483), shared so other mail-like views can
// show them too. A ToolCall is one call: its status icon, name, one-line input, and, open,
// its full input and result. A ToolGroup is a run of calls in one drawer, closed by default;
// its header counts the calls and shows the latest, so progress stays in view while closed.
// Given the agent, a call reads as its summary (S-1481, ./tool-summaries.ts): the tool in plain
// English and what the agent is doing, with the raw name and input behind the expand.
import { useRef } from 'react'
import { useFileBase } from '../files/fileBase'
import { fileHref } from '../files/fileKey'
import { fileLinkClick, resolvePath } from '../files/pathLinks'
import { Icon } from '../Icon'
import { toolLine, type ToolStatus } from '../views/ownview-model'
import { useToolSummary, useWatchCalls, type CallView } from './tool-summaries'

export interface ToolCallProps { name: string; input?: unknown; result?: string; status: ToolStatus; agent?: string; id?: string; watch?: boolean }
export type ToolCallItem = Omit<ToolCallProps, 'agent' | 'id' | 'watch'> & { id: string }

const TOOL_ICON: Record<ToolStatus, string> = { pending: 'circle', running: 'circle-dot', done: 'circle-check', error: 'circle-x' }
const Status = ({ status }: { status: ToolStatus }) => <span className={'ov-tool-st ' + status} title={status}><Icon name={TOOL_ICON[status]} size="xs" /></span>

// A file tool's one-line input (the path it reads or writes) is a link to that file (S-1529), resolved in the viewed agent's cwd.
const FILE_TOOLS = /^(read|edit|write|multiedit|notebookedit|view)$/i
function ToolInput({ name, input }: { name: string; input?: unknown }) {
  const base = useFileBase()
  const line = toolLine(input)
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const path = FILE_TOOLS.test(name) ? [o.file_path, o.filePath, o.path].find((v): v is string => typeof v === 'string') : undefined
  const abs = path ? resolvePath(path, base) : null
  if (!abs || path !== line) return <code>{line}</code>
  return <code><a className="file-link" href={fileHref(base.host, abs)} data-file-host={base.host} data-file-path={abs} title={`Open ${abs} on ${base.host}`} onClick={fileLinkClick}>{line}</a></code>
}

// A call's line: its summary, or its raw name and input. While it waits for its summary the
// line is drawn invisible, so nothing moves when it lands; once the raw line has shown, the
// summary fades in over it. `enter`: the line replaces another call's in a group's header, so it
// fades in. Keyed by call, so one call's raw line never carries over to the next.
function What({ view, name, input, enter }: { view: CallView; name: string; input?: unknown; enter?: boolean }) {
  const shownRaw = useRef(false)
  if (!view.summary && !view.held) shownRaw.current = true
  const raw = (fading: boolean) => <span className="ov-what-raw" aria-hidden={fading || undefined}><b>{name}</b><ToolInput name={name} input={input} /></span>
  const cls = 'ov-what' + (enter ? ' enter' : '')
  if (!view.summary) return <span className={cls + (view.held ? ' held' : '')}>{raw(false)}</span>
  const sum = <span className="ov-what-sum"><b>{view.summary.tool}</b><span>{view.summary.doing}</span></span>
  return shownRaw.current ? <span className={cls + ' fade'}>{raw(true)}{sum}</span> : <span className={cls}>{sum}</span>
}

export function ToolCall({ name, input, result, status, agent, id = '', watch = true }: ToolCallProps) {
  const el = useRef<HTMLDetailsElement>(null)
  useWatchCalls(watch ? agent : undefined, [{ id, name, input, status }], el)
  const view = useToolSummary(agent, id)
  const line = toolLine(input)
  const full = input === undefined ? '' : JSON.stringify(input, null, 2)
  return (
    <details className={'ov-tool ' + status} ref={el}>
      <summary><Icon name="chevron-right" size="xs" /><Status status={status} /><What view={view} name={name} input={input} /></summary>
      {view.summary ? <p className="ov-tool-raw"><b>{name}</b><ToolInput name={name} input={input} /></p> : null}
      {full && full !== JSON.stringify(line) ? <pre className="ov-tool-in">{full}</pre> : null}
      {result !== undefined ? <pre className="ov-tool-out">{result || '(no output)'}</pre> : status === 'running' || status === 'pending' ? <p className="ov-tool-wait">Running</p> : null}
    </details>
  )
}

// The header shows the latest call. A call streamed in while its summary is held leaves the
// previous call's line in place (summary or raw), so the header never goes blank; when the new
// call's summary lands or its hold ends, its line fades in. A group with nothing shown yet holds.
export function ToolGroup({ tools, agent }: { tools: ToolCallItem[]; agent?: string }) {
  const last = tools[tools.length - 1]
  const el = useRef<HTMLDetailsElement>(null)
  useWatchCalls(agent, tools, el)
  const view = useToolSummary(agent, last.id)
  const shown = useRef<ToolCallItem | null>(null)
  // The call whose line faded in after standing in for it, and whether the last draw stood in.
  const entered = useRef<string | null>(null)
  const stoodIn = useRef(false)
  const prev = view.held && shown.current && shown.current.id !== last.id ? shown.current : null
  const prevView = useToolSummary(agent, prev?.id ?? last.id)
  const head = prev ?? last
  if (!prev) {
    if (stoodIn.current) entered.current = last.id
    if (!view.held) shown.current = last
  }
  stoodIn.current = !!prev
  return (
    <details className={'ov-tools ' + last.status} ref={el}>
      <summary><Icon name="chevron-right" size="xs" /><span className="ov-tools-n">{tools.length} tool call{tools.length === 1 ? '' : 's'}</span><Status status={last.status} /><What key={head.id} view={prev ? { ...prevView, held: false } : view} name={head.name} input={head.input} enter={entered.current === head.id} /></summary>
      <div className="ov-tools-rows">{tools.map((t) => <ToolCall key={t.id} {...t} agent={agent} watch={false} />)}</div>
    </details>
  )
}
