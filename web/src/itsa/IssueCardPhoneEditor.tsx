// The issue card editor on a phone (S-1438 PR 7), Settings › Fields and cards › Issue card at 360-430 px, touch: the generic phone
// editor (CardPhoneEditor) over the issue card's kind. This file holds the issue's own: its Title section (locked, with its
// lines), its preview of one real ITSA, and the sample. The model is issue-layout.ts.
import { useMemo, useState, type ReactNode } from 'react'
import { Icon } from '../Icon'
import { CardPhoneEditor } from '../CardPhoneEditor'
import type { EditorRowCtx } from '../CardEditor'
import type { CellContext } from '../work/columns'
import type { Itsa } from '../types'
import { IssueCard, type IssueCardState } from './IssueCard'
import { bestPreview, issueEditorKind, sampleItsa, type IssueCardEditorProps } from './IssueCardEditor'
import { setTitleLines } from './issue-layout'

export type { IssueCardEditorProps }

// The issue's Title section: the locked title, and the lines the title clamps to.
function titleSection({ layout, apply }: EditorRowCtx): ReactNode {
  return (
    <section className="ipe-slot" aria-label="Title">
      <h3 className="eyebrow">Title</h3>
      <ul className="ipe-list" role="list">
        <li className="ipe-row locked"><span className="ipe-name">Title</span><span className="ipe-controls"><span className="ipe-lock"><Icon name="lock" size="xs" /></span></span></li>
      </ul>
      <div className="ipe-lines-row">
        <span className="muted" id="ipe-lines-label">Lines</span>
        <div className="seg ipe-lines" role="radiogroup" aria-labelledby="ipe-lines-label">
          {([1, 2, 3] as const).map((n) => (
            <button key={n} type="button" role="radio" aria-checked={(layout.titleLines ?? 3) === n} className={(layout.titleLines ?? 3) === n ? 'on' : ''}
              onClick={() => { if ((layout.titleLines ?? 3) === n) return; apply(setTitleLines(layout, n), `Title on ${n} line${n === 1 ? '' : 's'}`) }}>{n}</button>
          ))}
        </div>
      </div>
    </section>
  )
}

export function IssueCardPhoneEditor({ layout, items, fields, itsas, extras, onChange, onReset }: IssueCardEditorProps) {
  // The preview ITSA: the one the human picked, else the open ITSA that fills the most slots (owner, fields, links).
  const [pick, setPick] = useState<string | null>(null)
  const shown = itsas.find((x) => x.id === pick) ?? bestPreview(itsas)
  const sample = useMemo(() => (shown ? null : sampleItsa()), [shown])
  const preview = shown ?? sample
  const parentKey = preview?.parent_id ? itsas.find((x: Itsa) => x.id === preview.parent_id)?.key ?? null : null
  const cx: CellContext = { now: Date.now(), extras }
  const state: IssueCardState = { column: 'preview', mode: 'category', parentKey, dragging: false, items: new Map(items.map((i) => [i.id, i])), fields, cx }
  const noop = () => {}
  const actions = { onOpen: noop, onPointerDown: noop, onKeyDown: noop, onMenu: noop }

  return (
    <CardPhoneEditor
      kind={issueEditorKind}
      layout={layout}
      items={items}
      preview={{
        picks: itsas.map((x) => ({ id: x.id, label: `${x.key} ${x.title}` })), picked: preview?.id ?? 'sample', pickLabel: 'Preview', none: 'Sample issue',
        onPick: setPick,
        render: () => (preview ? <IssueCard itsa={preview} layout={layout} size="board" state={state} actions={actions} /> : null),
      }}
      above={titleSection}
      onChange={onChange}
      onReset={onReset}
    />
  )
}
