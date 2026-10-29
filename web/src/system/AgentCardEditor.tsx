// The agent card editor (S-1438 PR 8), Settings › Fields and cards › Agent card: the generic card editors (CardEditor on a desktop,
// CardPhoneEditor on a phone) over the agent card's kind (agent-layout.ts). Its own parts are the locked mark and name in HEAD,
// the ISSUE switch (the nested issue card on or off; its contents are the issue layout's), the context hairline, and the live
// preview: the real SystemCard for an agent the human picks, drawn with its owned ITSA and the layouts the system view uses.
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import './system.css'
import { CardEditor, type CardEditorKind, type EditorRowCtx } from '../CardEditor'
import { CardPhoneEditor } from '../CardPhoneEditor'
import { AGENT_SLOTS, ISSUE_ITEM, isAgentLocked, issueOn, setHairline, setIssueOn, agentModel } from '../agent-layout'
import type { CardLayout } from '../card-layout'
import type { Field } from '../itsa/fields'
import { cardItemMap } from '../itsa/IssueCard'
import type { CardItem } from '../work/card-items'
import type { WorkExtras } from '../work/data'
import type { Agent, Itsa } from '../types'
import { statusInfo } from '../itsa/itsa'
import { cardBadges, contextShare, ownedItsa } from './model'
import { agentBadgeRows, agentFootRows, nestedRows } from './layout'
import { activityOf, CardLayoutsContext, cardSig, issueCxSig, SystemCard, type CardLayouts, type CardModel } from './SystemCard'
import { shortName } from './names'

// The agent card's names for its slots, and its kind for the generic editors.
export const AGENT_SLOT_NAMES: Record<string, string> = { HEAD: 'Head', ISSUE: 'Issue', BADGES: 'Badges', FOOT: 'Foot' }
export const agentEditorKind: CardEditorKind = {
  m: agentModel,
  slots: AGENT_SLOTS,
  names: AGENT_SLOT_NAMES,
  lockedRows: { HEAD: ['Mark', 'Name'] },
  isLocked: isAgentLocked,
}

// The items the agent editor offers as chips: the agent card's registry, without the issue item, which the ISSUE switch sets.
export const agentChipItems = (items: CardItem[]): CardItem[] => items.filter((i) => i.id !== ISSUE_ITEM)

// The agent's preview ITSA: the open one it owns that is first in the list, else none.
// The ITSA the system view draws on the agent's card: the same rule (ownedItsa), with the same status categories.
const ownedOf = (a: Agent, itsas: Itsa[]): Itsa | null => ownedItsa(a.id, itsas.filter((x) => x.owner === a.id), (s) => statusInfo(s).category, (s) => statusInfo(s).human)?.it ?? null

// The card the system view would draw for the agent, built the way SystemView builds one (the same fields it reads).
export function previewModel(a: Agent, itsas: Itsa[], layout: CardLayout, fields: Field[], extras: WorkExtras): CardModel {
  const own = ownedOf(a, itsas)
  return {
    id: a.id, short: shortName(a.name, null), agent: a, activity: activityOf(a), it: own, owns: own ? 1 : 0,
    badges: own ? cardBadges(own, layout.slots.BADGES ?? [], fields) : [],
    cx: { now: Date.now(), extras }, cxSig: issueCxSig(own, extras),
    unread: a.unread ?? 0, ctx: contextShare(a, a.context_window ?? 1), ctxLevel: a.context_level ?? 0,
    kids: 0, folded: null, hit: '', rollup: null,
  }
}

// The agent card as the system view draws it, for the picked agent: the real SystemCard in the view's variables.
function AgentPreview({ agent, agentLayout, issue, items, fields, itsas, extras }: {
  agent: Agent | null; agentLayout: CardLayout; issue: CardLayout; items: CardItem[]; fields: Field[]; itsas: Itsa[]; extras: WorkExtras
}) {
  const value = useMemo<CardLayouts>(() => ({ agent: agentLayout, issue, items: cardItemMap(fields), fields }), [agentLayout, issue, items, fields])
  if (!agent) return <p className="muted">No agent to preview.</p>
  const m = previewModel(agent, itsas, agentLayout, fields, extras)
  // The row variables the view sets (SystemView), so the card's height follows its layout here too: the same formula as .sv-card (system.css).
  const style = {
    '--sv-issue-h': `calc(var(--space-4) * ${nestedRows(issue, agentLayout)})`,
    '--sv-badges-h': `calc(var(--space-4) * ${agentBadgeRows(agentLayout)})`,
    '--sv-foot-h': `calc(var(--space-4) * ${agentFootRows(agentLayout)})`,
    position: 'relative', width: 'var(--sv-card-w)',
    height: 'calc(var(--sv-card-h) - var(--space-4) * 3 + var(--sv-issue-h) + var(--sv-badges-h) + var(--sv-foot-h))',
  } as CSSProperties
  return (
    <CardLayoutsContext.Provider value={value}>
      <div className="sv aec-preview" style={style}>
        <SystemCard m={m} sig={cardSig(m)} place={{ x: 0, y: 0, w: 216 }} selected={false} enter={null} jump={false} far="" />
      </div>
    </CardLayoutsContext.Provider>
  )
}

// The rows the agent kind draws around its slots: the context hairline, below the Available list.
function hairlineRow({ layout, apply }: EditorRowCtx): ReactNode {
  const on = layout.hairline !== false
  return (
    <div className="ice-row" data-slot="HAIRLINE">
      <span className="ice-slot-name">Context</span>
      <div className="ice-chips">
        <label className="ice-switch"><input type="checkbox" role="switch" checked={on} aria-label="Context hairline" onChange={(e) => apply(setHairline(layout, e.target.checked), `Context hairline ${e.target.checked ? 'on' : 'off'}`)} />Context hairline</label>
      </div>
    </div>
  )
}

// The ISSUE switch: the nested issue card on or off.
const issueSwitch = (layout: CardLayout, set: (on: boolean) => void) => ({ slot: 'ISSUE', label: 'Issue', on: issueOn(layout), set })

export interface AgentCardEditorProps {
  // The agent card's layout, and the issue layout the nested card draws from.
  layout: CardLayout
  issue: CardLayout
  // The agent card's items (cardItemsFor('agent')), and the fields the card may show.
  items: CardItem[]
  fields: Field[]
  agents: Agent[]
  itsas: Itsa[]
  extras: WorkExtras
  onChange: (layout: CardLayout) => void
  onReset: () => void
}

// The preview's agent: the one the human picked, else the first agent.
function usePick(agents: Agent[]) {
  const [pick, setPick] = useState<string | null>(null)
  const shown = agents.find((a) => a.id === pick) ?? agents[0] ?? null
  return { shown, setPick }
}

export function AgentCardEditor({ layout, issue, items, fields, agents, itsas, extras, onChange, onReset }: AgentCardEditorProps) {
  const { shown, setPick } = usePick(agents)
  const chips = agentChipItems(items)
  return (
    <CardEditor
      kind={agentEditorKind}
      layout={layout}
      items={chips}
      label="Agent card slots"
      preview={{
        picks: agents.map((a) => ({ id: a.id, label: a.name })), picked: shown?.id ?? '', pickLabel: 'Preview', none: 'No agent',
        onPick: setPick,
        render: () => <AgentPreview agent={shown} agentLayout={layout} issue={issue} items={items} fields={fields} itsas={itsas} extras={extras} />,
      }}
      switchSlot={issueSwitch(layout, (on) => onChange(setIssueOn(layout, on)))}
      below={hairlineRow}
      onChange={onChange}
      onReset={onReset}
    />
  )
}

export function AgentCardPhoneEditor({ layout, issue, items, fields, agents, itsas, extras, onChange, onReset }: AgentCardEditorProps) {
  const { shown, setPick } = usePick(agents)
  const chips = agentChipItems(items)
  return (
    <CardPhoneEditor
      kind={agentEditorKind}
      layout={layout}
      items={chips}
      preview={{
        picks: agents.map((a) => ({ id: a.id, label: a.name })), picked: shown?.id ?? '', pickLabel: 'Preview', none: 'No agent',
        onPick: setPick,
        render: () => <AgentPreview agent={shown} agentLayout={layout} issue={issue} items={items} fields={fields} itsas={itsas} extras={extras} />,
      }}
      switchSlot={issueSwitch(layout, (on) => onChange(setIssueOn(layout, on)))}
      below={(ctx) => (
        <section className="ipe-slot" aria-label="Context">
          <label className="ipe-switch"><input type="checkbox" role="switch" checked={ctx.layout.hairline !== false} aria-label="Context hairline"
            onChange={(e) => ctx.apply(setHairline(ctx.layout, e.target.checked), `Context hairline ${e.target.checked ? 'on' : 'off'}`)} />Context hairline</label>
        </section>
      )}
      onChange={onChange}
      onReset={onReset}
    />
  )
}
