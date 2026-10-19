import { itsa, Later, SvStage, cost, worker, type SvPx } from '../stories/system'
import { STATUSES } from '../stories/mailFixtures'
import { ds, type Story } from '../stories/types'
import type { Agent } from '../types'
import { shortName } from './names'
import { orbRadius } from './stars'
import { activityOf, cardSig, type CardModel } from './SystemCard'
import { StarCard } from './StarCard'

const KEY = (n: string, status = 'in_progress') => itsa({ id: 'st-i-' + n, key: 'FX-' + n, title: 'Fixture ' + n, owner: 'st-' + n, status })
function model(a: Agent | null, o: Partial<CardModel> = {}): CardModel {
  return { id: a?.id ?? 'human', short: a ? shortName(a.name, 'fixture-cos') : 'You', agent: a, activity: a ? activityOf(a) : '', it: null, owns: 0, badges: [], unread: 0, ctx: 0, ctxLevel: 0, kids: 0, folded: null, hit: '', rollup: null, ...o }
}
const star = (id: string, name: string, o: Partial<Agent>) => worker('st-' + id, name, 'st-cos', o)

// Stars three to a row on the stage (a label's width and a gap apart): an orb takes the room of
// the largest one, and its label hangs under it.
const COLS = 3
const rowH = (px: SvPx) => px.orbMax * 2 + px.starLabelGap + px.starLabelH + px.pad
const heightOf = (n: number) => (px: SvPx) => px.pad + Math.ceil(n / COLS) * rowH(px)
// The orb's place for the i-th star, `w` across (the orb's middle sits at the label's).
const placeOf = (px: SvPx, i: number, w = px.orbMax * 2) => ({ x: px.pad + (i % COLS) * (px.starLabelW + px.pad) + (px.starLabelW - w) / 2, y: px.pad + Math.floor(i / COLS) * rowH(px) + px.orbMax - w / 2, w })
function Stars({ ms, selected }: { ms: CardModel[]; selected?: string }) {
  return (
    <SvStage height={heightOf(ms.length)}>
      {(px: SvPx) => ms.map((m, i) => <StarCard key={m.id} m={m} sig={cardSig(m)} place={placeOf(px, i, (m.agent ? px.orbMax : px.orbHuman) * 2)} selected={selected === m.id} enter={null} jump={false} dims={{ orbMax: px.orbMax, stackOver: px.stackOver }} />)}
    </SvStage>
  )
}
// An orb's diameter for a spend, as the layout sizes it (`orbRadius`, the radius following the square root of spend over the largest, clamped to the tokens' range).
const MAX_COST = 12.1
const across = (px: SvPx, cost: number) => orbRadius(cost, MAX_COST, { rMin: px.orbMin, rMax: px.orbMax }) * 2

export const stories: Story[] = [{
  name: 'Star card',
  group: 'System view',
  what: 'One agent as a star on the system view\'s Stars layout: an orb whose size is its spend, drawn as the agent\'s mark (the harness hue inside the state ring), with its name under it, then the ITSA it owns and its cost. Unread mail stacks on the orb\'s top-right corner as on a card, and a folded manager shows how many agents it hides. The human is a star too, headed You. The orb is the star\'s one control: it opens the same details as a card does.',
  when: 'In the `w:system` view with the layout switched to Stars (`#view=system&mode=stars`, or the header\'s **Stars** button), one per agent near the viewport. The Stars layout puts the chief of staff in the middle and the rest on rings round it, wider than tall on a desktop and taller than wide on a phone; a manager\'s team sits next to it.',
  code: ['web/src/system/StarCard.tsx#StarCard', 'web/src/system/StarCard.tsx#StarDims'],
  rules: [
    'The orb\'s radius follows the square root of the agent\'s spend in API dollars over the largest spend among the stars (so the area follows spend), clamped from `--sv-orb-min` to `--sv-orb-max`; the human\'s is `--sv-orb-human`. Each orb is given the room of the largest one, so a spend that grows an orb never moves it or any other.',
    'A spend change resizes the orb on the grow spring (bounce 0.15, 2.5 slows), by `transform` and `translate` alone, from its top-left corner, while the middle stays put; the label, stack and fold ride the orb\'s edge as drawn. A resize that interrupts another starts from the size drawn then.',
    'The mark is the harness hue inside a state ring (' + ds('In stam') + '); a ring never spins or pulses, and the ring\'s colour is never the only channel: the name and state are in the orb\'s label for assistive tech.',
    'The label takes no pointer, so one reaching over a neighbour\'s orb never steals its click. Below zoom 1 it is drawn at screen size, so a name never draws under 14 px; one that would cover another star or label is hidden, and shows on hover, focus or selection. Zoomed far out the star keeps its name and drops the key and cost.',
    'On a phone the orb\'s hit area keeps a finger\'s size on screen however far out (`--size-hit-touch`).',
    'Spawn, archive, stamp and roll move a star as they move a card: a spawn grows out of its parent from scale 0.96, an archive shrinks back into it, a status change stamps the ITSA\'s mark, and its cost rolls with a "+$" rising. Mail that just landed outlines the orb for `--duration-mark`: the accent, or the warning colour for the human and for an ask.',
  ],
  states: [
    {
      name: 'Orbs sized by spend', data: { itsaStatuses: STATUSES },
      render: () => <SvStage height={heightOf(5)}>
        {(px) => [0.1, 0.8, 3.1, 7.6, MAX_COST].map((spend, i) => {
          const a = star('s' + i, 'fixture-s' + (i + 1), { cost: cost(spend), activity: 'idle' })
          const m = model(a, { it: KEY('s' + i), owns: 1 })
          return <StarCard key={a.id} m={m} sig={cardSig(m)} place={placeOf(px, i, across(px, spend))} selected={false} enter={null} jump={false} dims={{ orbMax: px.orbMax, stackOver: px.stackOver }} />
        })}
      </SvStage>,
    },
    {
      name: 'Each harness and state', data: { itsaStatuses: STATUSES },
      render: () => <Stars ms={[
        model(star('a', 'fixture-claude', { activity: 'working', cost: cost(2.1) }), { it: KEY('a'), owns: 1 }),
        model(star('b', 'fixture-codex', { harness: 'codex', model: 'gpt-6.1-sol', activity: 'waiting', cost: cost(0.8) }), { it: KEY('b', 'in_review'), owns: 1 }),
        model(star('c', 'fixture-opencode', { harness: 'opencode', model: 'openrouter/fixture/flash', activity: 'blocked', cost: cost(0.4) }), { it: KEY('c', 'needs_approval'), owns: 1 }),
        model(star('d', 'fixture-broken', { harness: 'codex', activity: 'errored', cost: cost(0.1) })),
        model(star('e', 'fixture-paused', { harness: 'opencode', lifecycle: 'paused', activity: null })),
      ]} />,
    },
    {
      name: 'You, the human', data: { itsaStatuses: STATUSES },
      render: () => <Stars ms={[model(null, { unread: 3, badges: [{ kind: 'word', id: 'waiting', word: '1 waiting on you', tone: 'warn', title: 'Asks, decisions, and ITSAs waiting on you' }] })]} />,
    },
    {
      name: 'Mail, a fold and a selection', data: { itsaStatuses: STATUSES },
      render: () => <Stars selected="st-sel" ms={[
        model(star('m', 'fixture-mail', { cost: cost(1.2) }), { unread: 2, hit: 'mail', it: KEY('m'), owns: 1 }),
        model(star('f', 'fixture-folded', { role: 'manager', cost: cost(0.9, 6) }), { folded: { n: 4, states: [{ state: 'working', n: 3 }, { state: 'blocked', n: 1 }] } }),
        model(star('sel', 'fixture-picked', { cost: cost(0.6) }), { it: KEY('sel'), owns: 1 }),
      ]} />,
    },
    {
      name: 'Spend grows', data: { itsaStatuses: STATUSES },
      render: () => <Later after={500}>{(late) => <SvStage height={heightOf(1)}>
        {(px) => {
          const a = star('g', 'fixture-grows', { cost: cost(late ? 9 : 1.5) })
          const m = model(a, { it: KEY('g'), owns: 1 })
          return <StarCard m={m} sig={cardSig(m)} place={placeOf(px, 0, across(px, late ? 9 : 1.5))} selected={false} enter={null} jump={false} dims={{ orbMax: px.orbMax, stackOver: px.stackOver }} />
        }}
      </SvStage>}</Later>,
    },
  ],
}]
