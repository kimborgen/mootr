// What the agent tree's marks mean: each state's mark with one plain line, then the row's
// badges. The ? in the Agents header opens it; agent tooltips name the state with the same line.
import { StateGlyph } from './Glyph'
import { Icon } from './Icon'
import { hideMenu, showPopover } from './ui/menu'

export const STATES: { state: string; label: string; text: string }[] = [
  { state: 'working', label: 'Working', text: 'Running a turn right now.' },
  { state: 'starting', label: 'Starting', text: 'Its harness is starting up.' },
  { state: 'waiting', label: 'Waiting', text: 'Done for now, but expects mail, a child, a job, a timer, or an external event. The icon after its name says which.' },
  { state: 'idle', label: 'Idle', text: 'Finished its turn and free for new work.' },
  { state: 'blocked', label: 'Blocked', text: 'Stopped at a prompt in its terminal, a permission or a question. Open it to answer.' },
  { state: 'errored', label: 'Errored', text: 'Its harness hit an error. Open it to see what failed.' },
  { state: 'paused', label: 'Paused', text: 'Paused with its conversation kept. Resume it from its menu.' },
  { state: 'shut_down', label: 'Shut down', text: 'Not running: shut down or archived. Listed under Stopped.' },
]

// The state's line for a tooltip: "Blocked: stopped at a prompt …".
export function stateHelp(s: string) {
  const x = STATES.find((y) => y.state === s) ?? (s === 'archived' ? STATES[STATES.length - 1] : undefined)
  return x ? `${x.label}: ${x.text[0].toLowerCase()}${x.text.slice(1)}` : s
}

const BADGES: { mark: React.ReactNode; text: string }[] = [
  { mark: <span className="badge warn"><Icon name="shield-alert" size="xs" /></span>, text: 'Needs your approval. Tap it to open the request.' },
  { mark: <span className="badge warn"><Icon name="user" size="xs" /></span>, text: 'Waiting for you to reply.' },
  { mark: <span className="wait-mark"><Icon name="clock" size="xs" />4m</span>, text: 'What it waits for: a reply, children, a job, or a timer with time left.' },
  { mark: <span className="badge">2</span>, text: 'Unread mail for it. Tap to open its inbox.' },
  { mark: <span className="ctxbar l1"><i style={{ width: '70%' }} /></span>, text: 'Context used before forced compaction. Amber, then rust, as it fills.' },
  { mark: <span style={{ color: 'var(--st-errored)', display: 'inline-grid' }}><Icon name="zap" size="xs" /></span>, text: 'Runs with permission checks bypassed.' },
  { mark: <span className="muted" style={{ display: 'inline-grid' }}><Icon name="server" size="xs" /></span>, text: 'Runs on another machine.' },
]

function Legend() {
  return <>
    <div className="lg-head"><span className="eyebrow">Agent states</span>
      <button className="icon-btn" data-legend-close aria-label="Close" onClick={() => hideMenu(true)}><Icon name="x" size="xs" /></button></div>
    <dl className="legend">
      {STATES.map((s) => <div key={s.state} className="lg-row" data-legend={s.state}><dt><StateGlyph state={s.state} /></dt><dd><b>{s.label}</b>{s.text}</dd></div>)}
    </dl>
    <div className="lg-head"><span className="eyebrow">Badges</span></div>
    <dl className="legend">
      {BADGES.map((b, i) => <div key={i} className="lg-row"><dt>{b.mark}</dt><dd>{b.text}</dd></div>)}
    </dl>
  </>
}

export function showLegend(trigger: HTMLElement) {
  const r = trigger.getBoundingClientRect()
  showPopover(r.left, r.bottom + 4, 'Agent states', <Legend />, trigger)
}
