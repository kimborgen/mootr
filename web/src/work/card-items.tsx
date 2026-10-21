// The card items (S-2777): one registry of everything an issue card or an agent card can show. Every
// Work column carries its card form (WORK_COLUMNS, and each field column), and the items no column
// draws (an issue's kind, parent, roll-up, needs and owner; an agent's harness, name, model, tree
// cost, activity, context, mail, machine and state) are listed in CARD_ONLY. An item draws in two
// forms: `inline`, text on a META or FOOT line, and `chip`, a badge in the BADGES slot. A form draws
// nothing when its value is empty, so a card never shows "undefined". Ids are one namespace: a
// Work column id, a card-only id, or `field:<id>`.
import type { ReactNode } from 'react'
import { Icon } from '../Icon'
import { PersonGlyph, personName, RollupBar, rollupOf, rollupTotal, waitsOnHuman } from '../itsa/itsa'
import { getData } from '../store'
import { costShort, model, stateLabel } from '../format'
import { activityOf as agentActivity } from '../system/SystemCard'
import type { Agent, Itsa } from '../types'
import { fieldColumns } from './field-columns'
import type { Field } from '../itsa/fields'
import { badge, WORK_COLUMNS, type CellContext } from './columns'

export type CardWhere = 'issue' | 'agent'

// What a form reads: the issue (`it`) on an issue card, and on an agent card the ITSA it owns; `agent`
// is set on an agent card only. Either can be null, and a form then draws nothing for it.
export interface CardCtx { it: Itsa | null; agent: Agent | null; cx: CellContext }
export type CardForm = (c: CardCtx) => ReactNode

// Where an item may go, whether it is locked in place (the key and title, an agent's name), and its two forms.
// `chip` is absent for an item with no sensible badge (the card's BADGES slot doesn't take it).
export interface CardSpec { where: CardWhere[]; locked?: boolean; inline: CardForm; chip?: CardForm }
export interface CardItem extends CardSpec { id: string; label: string }

// The items no Work column draws. `cost` is in WORK_COLUMNS, and reads an agent's cost on an agent card.
export const CARD_ONLY: CardItem[] = [
  {
    id: 'kind', label: 'Kind', where: ['issue'],
    inline: ({ it }) => (it?.kind ? <span className="chip kind">{it.kind}</span> : null),
    chip: ({ it }) => (it?.kind ? badge(it.kind, 'Kind') : null),
  },
  {
    id: 'parent', label: 'Parent', where: ['issue'],
    inline: ({ it }) => {
      const key = it?.parent_id ? getData().itsas.find((x) => x.id === it.parent_id)?.key : null
      return key ? <span className="bc-parent" title="Parent"><Icon name="corner-left-up" size="xs" />{key}</span> : null
    },
    chip: ({ it }) => {
      const key = it?.parent_id ? getData().itsas.find((x) => x.id === it.parent_id)?.key : null
      return key ? badge(key, 'Parent') : null
    },
  },
  {
    id: 'rollup', label: 'Roll-up', where: ['issue'],
    inline: ({ it }) => {
      const r = it ? rollupOf(it.id, getData().itsas) : null
      return r && rollupTotal(r) ? <RollupBar r={r} /> : null
    },
    chip: ({ it }) => {
      const r = it ? rollupOf(it.id, getData().itsas) : null
      return r && rollupTotal(r) ? badge(<RollupBar r={r} />, 'Child ITSAs by status') : null
    },
  },
  {
    id: 'needs', label: 'Needs you', where: ['issue'],
    inline: ({ it }) => (it && waitsOnHuman(it) ? <span className="w-needs-mark"><Icon name="user" size="xs" />Needs you</span> : null),
    chip: ({ it }) => (it && waitsOnHuman(it) ? badge(<Icon name="user" size="xs" />, 'Waits on you', 'warn') : null),
  },
  {
    id: 'owner', label: 'Owner', where: ['issue'],
    inline: ({ it }) => (it?.owner ? <span title={`Owner: ${personName(it.owner)}`}><PersonGlyph id={it.owner} /></span> : null),
    chip: ({ it }) => (it?.owner ? badge(personName(it.owner), 'Owner') : null),
  },
  {
    id: 'harness', label: 'Harness', where: ['agent'],
    inline: ({ agent }) => (agent ? <span className="muted">{agent.harness}</span> : null),
    chip: ({ agent }) => (agent ? badge(agent.harness, 'Harness') : null),
  },
  {
    id: 'name', label: 'Name', where: ['agent'], locked: true,
    inline: ({ agent }) => (agent ? <span>{agent.name}</span> : null),
    chip: ({ agent }) => (agent ? badge(agent.name, 'Agent') : null),
  },
  {
    id: 'model', label: 'Model', where: ['agent'],
    inline: ({ agent }) => (agent ? <span className="muted">{model(agent).label.split(' ')[0]}</span> : null),
    chip: ({ agent }) => (agent ? badge(model(agent).label.split(' ')[0], agent.model ?? 'default model') : null),
  },
  {
    id: 'treecost', label: 'Tree cost', where: ['agent'],
    inline: ({ agent }) => {
      const c = agent?.cost
      return c && c.tree[c.mode] != null ? <span className="muted">tree {costShort(c.tree[c.mode], c.mode)}</span> : null
    },
    chip: ({ agent }) => {
      const c = agent?.cost
      return c && c.tree[c.mode] != null ? badge(`tree ${costShort(c.tree[c.mode], c.mode)}`, 'Cost of the agent and its children') : null
    },
  },
  {
    id: 'activity', label: 'Activity', where: ['agent'],
    inline: ({ agent }) => (agent ? <span>{agentActivity(agent)}</span> : null),
    chip: ({ agent }) => (agent ? badge(agentActivity(agent), 'Activity') : null),
  },
  {
    id: 'context', label: 'Context', where: ['agent'],
    inline: ({ agent }) => {
      const pct = contextPct(agent)
      return pct == null ? null : <span className="muted">{pct}% context</span>
    },
    chip: ({ agent }) => {
      const pct = contextPct(agent)
      return pct == null ? null : badge(`${pct}%`, `Context ${pct}% of the compaction limit`)
    },
  },
  {
    id: 'mail', label: 'Mail', where: ['agent'],
    inline: ({ agent }) => (agent?.unread ? <span>{agent.unread} unread</span> : null),
    chip: ({ agent }) => (agent?.unread ? badge(`${agent.unread} unread`, 'Unread mail') : null),
  },
  {
    id: 'machine', label: 'Machine', where: ['agent'],
    inline: ({ agent }) => (agent?.machine ? <span className="muted">{agent.machine}</span> : null),
    chip: ({ agent }) => (agent?.machine ? badge(agent.machine, 'Machine') : null),
  },
  {
    id: 'state', label: 'State', where: ['agent'],
    inline: ({ agent }) => (agent ? <span className="muted">{stateLabel(agent)}</span> : null),
    chip: ({ agent }) => (agent ? badge(stateLabel(agent), 'State') : null),
  },
]

// The share of the context window in use, or null when the agent reports no window.
function contextPct(a: Agent | null): number | null {
  if (!a?.context_tokens || !a.context_window) return null
  return Math.round(Math.min(1, a.context_tokens / a.context_window) * 100)
}

// Every card item: the Work columns with a card form, the card-only items, and a field column for
// each field. A card asks for the ones it may show with `where`.
export function cardItems(fields: Field[]): CardItem[] {
  const columns = WORK_COLUMNS.map((c) => ({ id: c.id, label: c.label, ...c.card }))
  const fieldItems = fieldColumns(fields).map((c) => ({ id: c.id, label: c.label, ...c.card }))
  return [...columns, ...CARD_ONLY, ...fieldItems]
}

// The items a card of this kind may show, in registry order.
export const cardItemsFor = (where: CardWhere, fields: Field[]): CardItem[] => cardItems(fields).filter((i) => i.where.includes(where))

// One item by its id, or undefined when no item has it.
export const cardItem = (id: string, fields: Field[]): CardItem | undefined => cardItems(fields).find((i) => i.id === id)
