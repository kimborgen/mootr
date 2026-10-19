// Settings › Decision steps: yes/no questions the decision model answers each time a tool is
// about to run or something happens (src/steps.ts). A list of the steps, each with an on/off
// box that saves at once, opening a form to change it, test it on recent examples, and read
// its decisions. Adding one is: pick a trigger, type the question, pick an action, save.
// Triggers come from the tool catalogue (GET /api/tools, as in Settings › Tools) and the
// API's event list.
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Icon } from '../Icon'
import { ago } from '../format'
import { toast } from '../ui/menu'
import { Loading } from '../Loading'

export type Trigger = { kind: 'tool'; tool: string } | { kind: 'event'; event: string }
export interface Step {
  id: string; name: string; trigger: Trigger; question: string; threshold: number
  action: string; enabled: boolean; builtin: string | null; created_at: string; updated_at: string
}
interface Decision { id: number; step_id: string; ts: string; subject: string; p: number | null; answer: boolean | null; action: string; error: string | null }
interface Example { subject: string; summary: string; p: number | null; answer: boolean | null; error?: string }
interface Catalog { groups: { name: string; tools: { name: string; description: string }[] }[] }

const EVENT_WORDS: Record<string, string> = {
  'mail-to-human': 'Each mail to you', 'itsa-created': 'Each new ITSA', 'itsa-status': 'Each ITSA status change', 'agent-spawned': 'Each new agent',
}
// The actions each trigger kind takes, in the order offered, with a line on what each does.
const ACTIONS: Record<'tool' | 'event', { v: string; label: string; desc: string }[]> = {
  tool: [
    { v: 'deny-if-yes', label: 'Deny the call if yes', desc: 'The tool doesn\'t run when the answer is yes.' },
    { v: 'approve-if-yes', label: 'Allow the call only if yes', desc: 'The tool runs only when the answer is yes.' },
  ],
  event: [
    { v: 'flag', label: 'Flag', desc: 'Record a yes in this step\'s log.' },
    { v: 'notify', label: 'Mail me', desc: 'Mail you on a yes, if your mail settings let it through.' },
    { v: 'annotate', label: 'Note it on the item', desc: 'Note a yes on the mail, ITSA, or agent it was about.' },
  ],
}
const DONE_WORDS: Record<string, string> = { denied: 'Denied', allowed: 'Allowed', flagged: 'Flagged', notified: 'Mailed you', annotated: 'Noted', none: 'Nothing', 'failed-open': 'Failed open' }

export const triggerWords = (t: Trigger) => (t.kind === 'tool' ? `Before ${t.tool}` : EVENT_WORDS[t.event] ?? t.event)
const actionWords = (a: string) => [...ACTIONS.tool, ...ACTIONS.event].find((x) => x.v === a)?.label ?? a
// What a decision was about, in words: `mail:ID`, `itsa:KEY`, `agent:NAME`, or `tool:NAME`.
const SUBJECT_WORDS: Record<string, string> = { mail: 'Mail', itsa: 'ITSA', agent: 'Agent', tool: 'A call of' }
function Subject({ s }: { s: string }) {
  const [kind, ...rest] = s.split(':')
  const words = SUBJECT_WORDS[kind]
  return words && rest.length ? <span className="step-subj">{words} <code>{rest.join(':')}</code></span> : <code className="step-subj">{s}</code>
}
const pct = (p: number | null) => (p === null ? '–' : `${Math.round(p * 100)}%`)
// The name a step gets when none is typed: the question's first words.
export function nameFrom(question: string): string {
  const words = question.trim().replace(/[?.!]+$/, '').split(/\s+/).filter(Boolean)
  let name = ''
  for (const w of words) {
    if (name && (name + ' ' + w).length > 40) break
    name = name ? name + ' ' + w : w
  }
  return name.slice(0, 60)
}
const triggerKey = (t: Trigger) => (t.kind === 'tool' ? `tool:${t.tool}` : `event:${t.event}`)
const keyTrigger = (k: string): Trigger => (k.startsWith('tool:') ? { kind: 'tool', tool: k.slice(5) } : { kind: 'event', event: k.slice(6) })

// `addTool` opens the add form with that tool picked (from Settings › Tools).
export function StepsSettings({ addTool }: { addTool?: string | null }) {
  const [steps, setSteps] = useState<Step[] | null>(null)
  const [events, setEvents] = useState<string[]>([])
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The step open in the form: its id, 'new', or null for the list.
  const [open, setOpen] = useState<string | null>(addTool ? 'new' : null)

  const load = async () => {
    try {
      const r = await api<{ steps: Step[]; events: string[] }>('GET', '/api/steps')
      setSteps(r.steps)
      setEvents(r.events)
    } catch (e) { setError((e as Error).message) }
  }
  useEffect(() => {
    void load()
    api<Catalog>('GET', '/api/tools').then(setCatalog).catch(() => setCatalog({ groups: [] }))
  }, [])

  if (error) return <p className="muted">{error}</p>
  if (!steps || !catalog) return <Loading className="muted" />
  if (open !== null) {
    const step = steps.find((s) => s.id === open)
    if (open === 'new' || step) {
      return <StepForm key={open} step={step} events={events} catalog={catalog} addTool={open === 'new' ? addTool ?? null : null}
        onSaved={async (s) => { await load(); setOpen(s.id) }} onDone={async () => { await load(); setOpen(null) }} />
    }
  }

  const toggle = async (s: Step) => {
    setSteps((xs) => xs!.map((x) => (x.id === s.id ? { ...x, enabled: !s.enabled } : x)))
    try { await api('PATCH', `/api/steps/${s.id}`, { enabled: !s.enabled }) } catch (e) { toast((e as Error).message); await load() }
  }
  return (
    <>
      <p className="lede">Yes/no questions the decision model answers each time a tool is about to run or something happens, such as a mail to you. A yes can deny or allow the call, flag it, mail you, or note it on the item.</p>
      <div className="set-card steps-card">
        {steps.map((s) => (
          <div className={`step-row ${s.enabled ? '' : 'off'}`} key={s.id} data-step={s.id}>
            <label className="step-on" title={s.enabled ? 'On' : 'Off'}>
              <input type="checkbox" checked={s.enabled} aria-label={`${s.name}: on`} onChange={() => void toggle(s)} />
            </label>
            <button type="button" className="step-open" onClick={() => setOpen(s.id)}>
              <span className="step-head"><b>{s.name}</b>{s.builtin ? <span className="badge">Built in</span> : null}{s.enabled ? null : <span className="badge">Off</span>}</span>
              <span className="step-meta">{triggerWords(s.trigger)} · {actionWords(s.action)}</span>
              <span className="step-q">{s.question}</span>
            </button>
            <Icon name="chevron-right" size="xs" />
          </div>
        ))}
        {steps.length ? null : <p className="muted steps-empty">No decision steps. Add one to ask a question each time a tool runs or something happens.</p>}
      </div>
      <button className="btn" id="add-step" onClick={() => setOpen('new')}><Icon name="plus" />Add a step</button>
    </>
  )
}

function StepForm({ step, events, catalog, addTool, onSaved, onDone }: {
  step?: Step; events: string[]; catalog: Catalog; addTool: string | null
  onSaved: (s: Step) => Promise<void>; onDone: () => Promise<void>
}) {
  const isNew = !step
  const startTrigger: Trigger = step?.trigger ?? (addTool ? { kind: 'tool', tool: addTool } : { kind: 'event', event: events[0] ?? 'mail-to-human' })
  const [trigger, setTrigger] = useState<Trigger>(startTrigger)
  const [question, setQuestion] = useState(step?.question ?? '')
  const [action, setAction] = useState(step?.action ?? ACTIONS[startTrigger.kind][0].v)
  const [name, setName] = useState(step && step.name !== nameFrom(step.question) ? step.name : '')
  const [threshold, setThreshold] = useState(String(step?.threshold ?? 0.5))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  // "More" starts open when it holds something other than the defaults.
  const [moreOpen] = useState(() => !!name || Number(threshold) !== 0.5)
  const actions = ACTIONS[trigger.kind]
  const toolDesc = trigger.kind === 'tool' ? catalog.groups.flatMap((g) => g.tools).find((t) => t.name === trigger.tool)?.description : undefined
  const body = () => ({ trigger, question: question.trim(), action, name: name.trim() || nameFrom(question), threshold: Number(threshold) })
  const dirty = isNew || JSON.stringify(body()) !== JSON.stringify({ trigger: step.trigger, question: step.question, action: step.action, name: step.name, threshold: step.threshold })

  const pickTrigger = (k: string) => {
    const t = keyTrigger(k)
    setErr('')
    setTrigger(t)
    if (!ACTIONS[t.kind].some((a) => a.v === action)) setAction(ACTIONS[t.kind][0].v)
  }
  // Saves, and returns the saved step (or null on a failure, shown under the form).
  async function save(): Promise<Step | null> {
    if (!question.trim()) { setErr('Type a question for the model to answer yes or no.'); return null }
    const th = Number(threshold)
    if (!Number.isFinite(th) || th < 0 || th > 1) { setErr('How sure takes a number from 0 to 1.'); return null }
    setBusy(true)
    try {
      const s = isNew ? await api<Step>('POST', '/api/steps', body()) : await api<Step>('PATCH', `/api/steps/${step.id}`, body())
      toast(`Saved ${s.name}`)
      return s
    } catch (e) { setErr((e as Error).message); return null } finally { setBusy(false) }
  }
  async function remove() {
    if (!step || !confirm(`Delete the step ${step.name}? Its decision log goes with it.`)) return
    try { await api('DELETE', `/api/steps/${step.id}`); toast(`Deleted ${step.name}`); await onDone() } catch (e) { setErr((e as Error).message) }
  }

  // Tools appear twice in name only (a tool group named Events), so events take their own label.
  const opts = (
    <>
      <optgroup label="When something happens">{events.map((e) => <option key={e} value={`event:${e}`}>{EVENT_WORDS[e] ?? e}</option>)}</optgroup>
      {catalog.groups.map((g) => (
        <optgroup key={g.name} label={`Before a tool runs: ${g.name}`}>{g.tools.map((t) => <option key={t.name} value={`tool:${t.name}`}>Before {t.name}</option>)}</optgroup>
      ))}
      {trigger.kind === 'tool' && !catalog.groups.some((g) => g.tools.some((t) => t.name === trigger.tool)) ? <option value={triggerKey(trigger)}>Before {trigger.tool}</option> : null}
    </>
  )

  return (
    <div className="step-form">
      <button type="button" className="btn type-back" onClick={() => void onDone()}><Icon name="arrow-left" size="xs" />Decision steps</button>
      <form aria-label={isNew ? 'New decision step' : `Decision step ${step.name}`} onSubmit={async (e) => { e.preventDefault(); const s = await save(); if (s) await onSaved(s) }}>
        {step?.builtin ? <p className="muted step-builtin"><span className="badge">Built in</span> mootr ships this step. You can change it or turn it off, not delete it.</p> : null}
        <div className="set-field">
          <b>When</b>
          <p>An event, or a tool about to run, grouped as in Settings › Tools.</p>
          <select name="trigger" value={triggerKey(trigger)} onChange={(e) => pickTrigger(e.target.value)}>{opts}</select>
          {toolDesc ? <p className="step-tool-desc">{toolDesc}</p> : null}
        </div>
        <div className="set-field">
          <b>Question</b>
          <p>Asked of the decision model with the {trigger.kind === 'tool' ? 'call\'s arguments' : 'event'} and who did it. Answered yes or no.</p>
          <textarea name="question" value={question} rows={3} placeholder={trigger.kind === 'tool' ? 'Would this call do something hard to undo?' : 'Is this about spending money?'}
            onChange={(e) => { setErr(''); setQuestion(e.target.value) }} />
        </div>
        <div className="set-field">
          <b>If yes</b>
          <div className="choice-cards step-actions" role="radiogroup" aria-label="If yes">
            {actions.map((a) => (
              <button type="button" role="radio" aria-checked={a.v === action} key={a.v} data-action={a.v} className={`choice ${a.v === action ? 'on' : ''}`} onClick={() => setAction(a.v)}>
                <span className="choice-top"><b>{a.label}</b><span className="radio" /></span>
                <span className="desc">{a.desc}</span>
              </button>
            ))}
          </div>
        </div>
        <details className="fold step-more" open={moreOpen}>
          <summary><Icon name="chevron-right" size="xs" />More</summary>
          <div className="set-row">
            <div className="set-label"><b>Name</b><p>Empty: the question's first words.</p></div>
            <div className="set-ctl"><input type="text" className="wide" name="name" value={name} placeholder={nameFrom(question) || 'The question\'s first words'} onChange={(e) => setName(e.target.value)} /></div>
          </div>
          <div className="set-row">
            <div className="set-label"><b>How sure</b><p>How sure the model must be before it counts as yes, from 0 to 1. Default 0.5.</p></div>
            <div className="set-ctl"><span className="num small"><input type="number" name="threshold" min={0} max={1} step={0.05} inputMode="decimal" value={threshold} onChange={(e) => { setErr(''); setThreshold(e.target.value) }} /></span></div>
          </div>
        </details>
        {err ? <p className="sp-error" role="alert">{err}</p> : null}
        <div className="row type-actions">
          <button type="submit" className="btn primary" disabled={busy || !dirty}>{isNew ? 'Add step' : 'Save'}</button>
          <button type="button" className="btn" onClick={() => void onDone()}>{isNew || dirty ? 'Cancel' : 'Done'}</button>
          <span className="spacer" />
          {step && !step.builtin ? <button type="button" className="btn danger" onClick={() => void remove()}><Icon name="trash-2" />Delete</button> : null}
        </div>
      </form>
      {step ? <StepTest step={step} dirty={dirty} save={save} onSaved={onSaved} /> : <p className="muted step-later">Once it's added you can test it on recent examples and read its decisions here.</p>}
      {step ? <StepLog step={step} /> : null}
    </div>
  )
}

// Runs the saved question on the trigger's last N examples. Nothing is acted on or logged.
// The preview runs the saved step, so a changed form is saved first.
function StepTest({ step, dirty, save, onSaved }: { step: Step; dirty: boolean; save: () => Promise<Step | null>; onSaved: (s: Step) => Promise<void> }) {
  const [n, setN] = useState(5)
  const [res, setRes] = useState<{ examples: Example[]; note?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function run() {
    setBusy(true)
    setErr('')
    try {
      if (dirty) {
        const s = await save()
        if (!s) return
        await onSaved(s)
      }
      setRes(await api('POST', `/api/steps/${step.id}/preview`, { n }))
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const yes = res?.examples.filter((x) => x.answer).length ?? 0
  return (
    <section className="step-test">
      <h3>Test on recent</h3>
      <p className="muted">Asks the question about the last few {step.trigger.kind === 'tool' ? `calls of ${step.trigger.tool}` : 'times it happened'}. Nothing is acted on or logged.</p>
      <div className="row step-test-ctl">
        <div className="seg" role="group" aria-label="How many">
          {[5, 10, 20].map((k) => <button type="button" key={k} className={k === n ? 'on' : ''} aria-pressed={k === n} onClick={() => setN(k)}>Last {k}</button>)}
        </div>
        <button type="button" className="btn" id="step-test" disabled={busy} onClick={() => void run()}><Icon name="play" />{busy ? 'Testing…' : dirty ? 'Save and test' : 'Test'}</button>
      </div>
      {err ? <p className="sp-error" role="alert">{err}</p> : null}
      {res ? (
        <div className="set-card step-results" aria-live="polite">
          {res.examples.length ? <p className="muted step-sum">Yes on {yes} of {res.examples.length}, at {step.threshold} or more.</p> : null}
          {res.examples.map((x, i) => (
            <div className="step-ex" key={i}>
              <Answer answer={x.answer} error={x.error} />
              <span className="step-ex-body"><span className="step-ex-sum">{x.summary}</span>{x.error ? <span className="step-ex-err">{x.error}</span> : null}</span>
              <span className="step-p">{pct(x.p)}</span>
            </div>
          ))}
          {!res.examples.length ? <p className="muted step-note">{res.note ?? 'No examples yet.'}</p> : null}
        </div>
      ) : null}
    </section>
  )
}

function Answer({ answer, error }: { answer: boolean | null; error?: string | null }) {
  if (error || answer === null) return <span className="badge err step-ans">Error</span>
  return answer ? <span className="badge progress step-ans">Yes</span> : <span className="badge step-ans">No</span>
}

// The step's newest decisions: when, about what, the answer, P(yes), and what it did.
function StepLog({ step }: { step: Step }) {
  const [log, setLog] = useState<Decision[] | null>(null)
  const [err, setErr] = useState('')
  const load = () => api<{ decisions: Decision[] }>('GET', `/api/steps/${step.id}/log?limit=50`).then((r) => setLog(r.decisions)).catch((e) => setErr((e as Error).message))
  useEffect(() => { void load() }, [step.id])
  return (
    <section className="step-log">
      <h3>Decisions <button type="button" className="icon-btn" title="Reload" aria-label="Reload the decisions" onClick={() => void load()}><Icon name="rotate-ccw" size="xs" /></button></h3>
      {err ? <p className="sp-error" role="alert">{err}</p> : null}
      {log === null && !err ? <Loading className="muted" /> : null}
      {log?.length === 0 ? <p className="muted">No decisions yet. Each time the step runs, its answer shows here.</p> : null}
      {log?.length ? (
        <div className="set-card step-decisions">
          {log.map((d) => (
            <div className="step-dec" key={d.id} data-action={d.action}>
              <Answer answer={d.answer} error={d.error && d.answer === null ? d.error : null} />
              <span className="step-dec-body">
                <Subject s={d.subject} />
                <span className="step-dec-meta"><time dateTime={d.ts} title={new Date(d.ts).toLocaleString()}>{ago(d.ts)}</time> · <span className={d.action === 'failed-open' ? 'step-failed' : ''}>{DONE_WORDS[d.action] ?? d.action}</span>
                  {d.error ? <span className="step-dec-err">: {d.error}</span> : null}</span>
              </span>
              <span className="step-p">{pct(d.p)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
