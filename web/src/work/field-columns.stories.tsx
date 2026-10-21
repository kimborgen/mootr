import { FIELDS, TREE_FIELDS } from '../stories/itsaFixtures'
import { Row } from '../stories/helpers'
import { ds, type Story } from '../stories/types'
import type { Field } from '../itsa/fields'
import { FieldValue, fieldColumn } from './field-columns'

const field = (key: string) => FIELDS.find((f) => f.key === key)!
const it = TREE_FIELDS.find((x) => x.id === 'fx-i-911')!
const val = (key: string) => it.fields![key]
const cell = (f: Field, v: unknown, label: string) => ({ label, node: <FieldValue f={f} v={v} /> })
const choice = (tone: 'ok' | 'warn' | 'bad' | 'muted' | 'accent'): Field => ({ ...field('area'), options: [{ value: 'x', label: `A ${tone} option`, tone }] })

export const stories: Story[] = [{
  name: 'Work field values',
  group: 'ITSA and work',
  what: 'How one ITSA field\'s value is drawn, by the field\'s type: text, number, choice (a badge in the option\'s tone), link (the host), date, and check. The same value shows as a column of the Work table and on the glance\'s cards; a field with no value draws nothing.',
  when: 'In the Work table, one column for each field after the built-in columns (id `field:ID`, so a saved layout keeps it through a key change), and on the glance\'s cards: fields set to "chip" join the meta line, the others follow it labelled. Fields are defined in Settings; they are shared by the ITSA home daemon.',
  code: ['web/src/work/field-columns.tsx#FieldValue', 'web/src/work/field-columns.tsx#fieldColumn', 'web/src/work/field-columns.tsx#withFieldFit', 'web/src/work/field-columns.tsx#cardFields'],
  rules: [
    'A choice is a `.badge` in the status tokens by tone: ok success, warn warning, bad error, accent in-progress, muted neutral; no new colour (' + ds('Status') + '). The option\'s label is the badge\'s text and title.',
    'A link shows only its host without `www.`, opens in a new tab, and does not open the row; a date reads as month and day, with the year when it is not this one, read as a calendar date so no time zone moves it.',
    'A check shows a tick in `--status-success-fg` only when on, with the label "Yes" (on a card chip the tick is named "Yes" for screen readers, as a role=img); off, empty, or unset draws nothing. Text is cut with an ellipsis and the whole value is its title; a number does not wrap and is right-aligned in the table.',
    'A field column has a width of s, m, or l on the space tokens, and drops out of the table with the built-in column to its right: a field never hides before a column after it, and the rightmost fields drop first.',
  ],
  states: [
    { name: 'Each type, with a value', render: () => (
      <Row items={[
        cell(field('note'), val('note'), 'text'), cell(field('estimate'), val('estimate'), 'number'), cell(field('area'), val('area'), 'choice'),
        cell(field('doc'), val('doc'), 'link'), cell(field('due'), val('due'), 'date'), cell(field('flag'), val('flag'), 'check'),
      ]} />) },
    { name: 'Choice tones', render: () => <Row items={(['ok', 'warn', 'bad', 'accent', 'muted'] as const).map((t) => ({ label: t, node: <FieldValue f={choice(t)} v="x" /> }))} /> },
    { name: 'A date in another year', render: () => <Row items={[cell(field('due'), '2031-03-09', 'date'), cell(field('due'), '2026-12-24', 'this year')]} /> },
    { name: 'No value, so nothing shows', render: () => (
      <Row items={[cell(field('note'), '', 'empty text'), cell(field('estimate'), undefined, 'unset number'), cell(field('flag'), false, 'check off'), cell(field('area'), null, 'unset choice')]} />) },
    { name: 'A long text, cut to the column', render: () => <div style={{ width: 'calc(var(--space-12) * 3)' }}><FieldValue f={field('note')} v="Waits on the tokenizer, which waits on the casing decision, which waits on a reply from the owner of the locale tables." /></div> },
    // The field's card form on an issue card (card-items.tsx, S-2777): the same value, drawn inline and as a chip.
    { name: 'Card form, inline and chip', render: () => <Row items={[
      { label: 'inline', node: fieldColumn(field('area')).card.inline({ it: it, agent: null, cx: { now: 0, extras: {} as never } }) },
      { label: 'chip', node: fieldColumn(field('area')).card.chip!({ it: it, agent: null, cx: { now: 0, extras: {} as never } }) },
    ]} /> },
  ],
}]
