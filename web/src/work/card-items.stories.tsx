import type { Itsa } from '../types'
import { ACTIVITY, COSTS } from '../stories/workFixtures'
import { AGENTS } from '../stories/fixtures'
import { FIELDS, itsa, itsaData, link } from '../stories/itsaFixtures'
import { Row } from '../stories/helpers'
import { ds, type Story } from '../stories/types'
import type { CardCtx, CardWhere } from './card-items'
import { cardItemsFor, type CardItem } from './card-items'
import type { WorkExtras } from './data'

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString()
const agent = AGENTS.find((a) => a.name === 'fixture-dev')!
const extras: WorkExtras = { costs: COSTS, activity: ACTIVITY, watch: {}, fields: null, fieldsFailed: false, fieldsStart: 0 }
const cx = { now: Date.now(), extras }

// One ITSA with every item filled: a parent (its kind, and the parent item), children (a roll-up),
// a status that waits on the human (needs you), a branch with a passing review and tests, and the
// test-env, Linear and other links; plus the field values. The store holds the family.
const branch = link(1, 'branch', 'fixture/index-builder', 'https://example.com/fixture/repo/tree/fixture/index-builder', {
  repo: 'fixture/repo',
  review: { verdict: 'approve', by: 'fixture-review', summary: null, at: ago(20) },
  tests: { passed: 212, failed: 0, skipped: 1, command: 'npm test', at: ago(25) },
})
const parent = itsa(910, null, 'Fixture search rewrite', 'in_progress', { kind: 'epic', health: 'on_track', min: 9000 })
const base = itsa(911, 910, 'Build the new index', 'needs_input', {
  owner: 'fx-dev', kind: 'issue', health: 'at_risk', min: 7000,
  links: [
    branch,
    link(2, 'github', 'fixture/repo#311', 'https://github.com/fixture/repo/pull/311'),
    link(3, 'preview', 'preview', 'https://preview.example.com/fixture'),
    link(4, 'linear', 'FX-12', 'https://linear.app/fixture/issue/FX-12'),
    link(5, 'link', 'design', 'https://docs.example.com/fixture/index'),
  ],
})
const it: Itsa = { ...base, fields: { area: 'search', estimate: 8, due: '2026-11-20', doc: 'https://docs.example.com/fixture/index', note: 'Waits on the tokenizer.', flag: true } } as Itsa
const kids = [
  itsa(912, 911, 'Tokenizer for mixed scripts', 'in_review', { owner: 'fx-review', min: 4000 }),
  itsa(913, 911, 'Scoring pass', 'in_progress', { min: 3000 }),
  itsa(914, 911, 'Old ranker removal', 'done', { min: 2000 }),
]
const family = itsaData([parent, it, ...kids])

const issue: CardCtx = { it, agent: null, cx }
const onAgent: CardCtx = { it, agent, cx }
const empty: CardCtx = { it: null, agent: null, cx }

// Every item a card of this kind may show, drawn in one form; an item with nothing to show says so.
const forms = (where: CardWhere, form: 'inline' | 'chip', c: CardCtx) => cardItemsFor(where, FIELDS).map((i: CardItem) => ({
  label: i.label + (i.locked ? ' (locked)' : ''),
  node: (i[form]?.(c) ?? <span className="muted">{i[form] ? '(nothing)' : '(no chip)'}</span>),
}))

export const stories: Story[] = [{
  name: 'Card items',
  group: 'ITSA and work',
  what: 'Every item an issue card or an agent card can show, in its two forms: inline, as text on a META or FOOT line, and chip, as a badge in the BADGES slot. One registry holds them all: each Work column carries its card form, each field column too, and the items no column draws (an issue\'s kind, parent, roll-up, needs and owner; an agent\'s harness, name, model, tree cost, activity, context, mail, machine and state) are listed beside them. An item with no value draws nothing.',
  when: 'The issue card on a board draws its slots from these forms (the card layout picks the items and their slots). The system view\'s agent cards draw from them once their card lands. This story is the reference for what each item looks like.',
  code: ['web/src/work/card-items.tsx#cardItems', 'web/src/work/card-items.tsx#cardItemsFor', 'web/src/work/card-items.tsx#CARD_ONLY'],
  rules: [
    'Items are text or a `.badge` in the status tokens by tone (' + ds('Status') + '); a chip is a badge, an inline item is muted text. No colour, size or duration is added here: the card reads its tokens.',
    'The key and the title of an issue, and an agent\'s name, are locked in place; every other item may move between the card\'s slots. On an issue card the health is a dot with its label as its name, the kind is a `.chip`, and each link kind is an icon; the chip forms keep the words.',
    'An item draws only what its card shows: an issue card gives it an ITSA, an agent card gives it the agent and the ITSA it owns, and a field draws on either. A missing value draws nothing, never "undefined" or a dash.',
  ],
  states: [
    { name: 'Issue card, inline', data: family, render: () => <Row items={forms('issue', 'inline', issue)} /> },
    { name: 'Issue card, chip', data: family, render: () => <Row items={forms('issue', 'chip', issue)} /> },
    { name: 'Agent card, inline', data: family, render: () => <Row items={forms('agent', 'inline', onAgent)} /> },
    { name: 'Agent card, chip', data: family, render: () => <Row items={forms('agent', 'chip', onAgent)} /> },
  ],
}, {
  name: 'Card items, nothing to show',
  group: 'ITSA and work',
  what: 'The card items with no ITSA and no agent: every form draws nothing, or says so where a form is absent.',
  when: 'The same place as the card items: a card with nothing to show in an item\'s slot, so the slot is empty rather than "undefined".',
  code: ['web/src/work/card-items.tsx#cardItemsFor'],
  rules: [
    'A form draws nothing for an empty value: no text, no badge, and no placeholder on the card.',
  ],
  states: [
    { name: 'Nothing to show', render: () => <Row items={[...forms('issue', 'inline', empty), ...forms('agent', 'chip', empty)]} /> },
  ],
}]
