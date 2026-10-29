// The issue card editor (S-1438 PR 6), Settings › Fields and cards › Issue card on a desktop: the generic card editor (CardEditor)
// over the issue card's kind. This file holds what is the issue's own: its locked Key and Title, the Lines control, the preview
// of one real ITSA (or a sample when there are none), and the sample. The model is issue-layout.ts.
import { useMemo, useState, type ReactNode } from 'react'
import { Icon } from '../Icon'
import type { CardLayout } from '../card-layout'
import { CardEditor, reasonOf as reasonOfKind, type CardEditorKind, type EditorRowCtx } from '../CardEditor'
import type { CellContext } from '../work/columns'
import type { CardItem } from '../work/card-items'
import type { WorkExtras } from '../work/data'
import type { Field } from './fields'
import type { Itsa } from '../types'
import { IssueCard, type IssueCardState } from './IssueCard'
import { statusInfo } from './itsa'
import { isLocked, ISSUE_SLOTS, issueModel, setTitleLines } from './issue-layout'
import type { Refusal } from '../card-model'

// The slots as the editor names them.
export const SLOT_NAMES: Record<string, string> = { TOP: 'Top', META: 'Meta', BADGES: 'Badges', FOOT: 'Foot' }

// The issue card's kind for the generic editor: its model, slots, names, and the Key it locks in TOP.
export const issueEditorKind: CardEditorKind = { m: issueModel, slots: ISSUE_SLOTS, names: SLOT_NAMES, lockedRows: { TOP: ['Key'] }, isLocked }

// A stand-in ITSA for the preview when the page has none yet (a sample, never a live record).
export const sampleItsa = (): Itsa => {
  const now = new Date().toISOString()
  return {
    id: 'sample', key: 'S-1', parent_id: null, kind: 'issue', title: 'Sample issue for the card preview', summary: null, body: null,
    status: 'in_progress', owner: null, thread_id: null, created_by: '', created_at: now, updated_at: now, closed_at: null, links: [],
  }
}

// The preview ITSA when the human has picked none: the open ITSA that fills the most slots (owner, fields, links).
export const bestPreview = (itsas: Itsa[]): Itsa | null => {
  const fills = (x: Itsa) => (x.owner ? 1 : 0) + (x.links?.length ? 1 : 0) + Object.values(x.fields ?? {}).filter((v) => v !== null && v !== '').length
  const open = (x: Itsa) => statusInfo(x.status).category !== 'closed'
  return [...itsas].sort((a, b) => Number(open(b)) - Number(open(a)) || fills(b) - fills(a))[0] ?? null
}

// The words a refusal shows, for the slot it was for (the issue's names).
export const reasonOf = (r: Refusal, item: string, slot: string, label: (id: string) => string): string => reasonOfKind(r, item, slot, label, issueEditorKind)

export interface IssueCardEditorProps {
  layout: CardLayout
  // The items the issue card may show (cardItemsFor('issue', fields)), in registry order.
  items: CardItem[]
  fields: Field[]
  itsas: Itsa[]
  extras: WorkExtras
  onChange: (layout: CardLayout) => void
  onReset: () => void
}

// The issue's Title row: the locked title, and the lines the title clamps to.
function titleRow({ layout, apply }: EditorRowCtx): ReactNode {
  return (
    <div className="ice-row" role="listitem" data-slot="TITLE">
      <span className="ice-slot-name">Title</span>
      <div className="ice-chips">
        <span className="ice-chip locked"><Icon name="lock" size="xs" />Title</span>
        <span className="muted ice-lines-label" id="ice-lines-label">Lines</span>
        <div className="seg ice-lines" role="radiogroup" aria-labelledby="ice-lines-label">
          {([1, 2, 3] as const).map((n) => (
            <button key={n} type="button" role="radio" aria-checked={(layout.titleLines ?? 3) === n} className={(layout.titleLines ?? 3) === n ? 'on' : ''}
              onClick={() => apply(setTitleLines(layout, n), `Title on ${n} line${n === 1 ? '' : 's'}`)}>{n}</button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function IssueCardEditor({ layout, items, fields, itsas, extras, onChange, onReset }: IssueCardEditorProps) {
  // The preview ITSA: the one the human picked, else the open ITSA that fills the most slots (owner, fields, links).
  const [pick, setPick] = useState<string | null>(null)
  const shown = itsas.find((x) => x.id === pick) ?? bestPreview(itsas)
  const sample = useMemo(() => (shown ? null : sampleItsa()), [shown])
  const preview = shown ?? sample
  const parentKey = preview?.parent_id ? itsas.find((x) => x.id === preview.parent_id)?.key ?? null : null
  const cx: CellContext = { now: Date.now(), extras }
  // A column that is not the preview's status, so the card shows its status in META as a board in another column does.
  const state: IssueCardState = { column: 'preview', mode: 'category', parentKey, dragging: false, items: new Map(items.map((i) => [i.id, i])), fields, cx }
  const noop = () => {}
  const actions = { onOpen: noop, onPointerDown: noop, onKeyDown: noop, onMenu: noop }

  return (
    <CardEditor
      kind={issueEditorKind}
      layout={layout}
      items={items}
      label="Issue card slots"
      preview={{
        picks: itsas.map((x) => ({ id: x.id, label: `${x.key} ${x.title}` })), picked: preview?.id ?? 'sample', pickLabel: 'Preview', none: 'Sample issue',
        onPick: setPick,
        render: () => (preview ? <IssueCard itsa={preview} layout={layout} size="board" state={state} actions={actions} /> : null),
      }}
      above={titleRow}
      onChange={onChange}
      onReset={onReset}
    />
  )
}
