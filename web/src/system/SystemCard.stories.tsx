import { useEffect, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { agent } from '../stories/fixtures'
import { itsa, Later, SvStage, cost, worker, type SvPx } from '../stories/system'
import { STATUSES } from '../stories/mailFixtures'
import { ds, type Story } from '../stories/types'
import type { Agent, Itsa } from '../types'
import { shortName } from './names'
import { activityOf, cardSig, SystemCard, type CardModel, type CardPlace, type Exit, type Far } from './SystemCard'

const DEV = worker('cd-dev', 'fixture-dev', 'cd-cos', { activity: 'working', activity_detail: 'Editing the tree layout', context_tokens: 310000, context_level: 1, cost: cost(2.4), unread: 2 })
const WORK: Itsa = itsa({ id: 'ci-1', key: 'FX-12', title: 'Lay out the tree', owner: 'cd-dev', health: 'at_risk' })

// A card's model from an agent (null is the human), as the view builds it, with what a state sets.
function model(a: Agent | null, o: Partial<CardModel> = {}): CardModel {
  return { id: a?.id ?? 'human', short: a ? shortName(a.name, 'fixture-cos') : 'You', agent: a, activity: a ? activityOf(a) : '', it: null, owns: 0, badges: [], unread: 0, ctx: 0, ctxLevel: 0, kids: 0, folded: null, hit: '', rollup: null, ...o }
}
const AT_RISK = [{ kind: 'word' as const, id: 'health', word: 'at risk', tone: 'warn' as const, title: 'Health: at risk' }]
const TREE = { ...worker('cd-lead', 'fixture-lead', 'cd-cos', { role: 'manager', activity: 'working', cost: cost(1.2, 8.6), context_tokens: 120000 }) }

// The cards in a column on the stage, each at its own place, as the phone's Cards draws them.
const place = (px: SvPx, i: number, w = px.card): CardPlace => ({ x: px.pad, y: px.pad + i * (px.cardH + px.rowGap), w })
const heightOf = (n: number) => (px: SvPx) => px.pad * 2 + n * px.cardH + (n - 1) * px.rowGap
function Cards({ ms, far = '', selected, enter }: { ms: CardModel[]; far?: Far; selected?: string; enter?: Record<string, CardPlace> }) {
  return (
    <SvStage height={heightOf(ms.length)} far={!!far}>
      {(px) => ms.map((m, i) => <SystemCard key={m.id} m={m} sig={cardSig(m)} place={place(px, i)} selected={selected === m.id} enter={enter?.[m.id] ?? null} jump={false} far={far} />)}
    </SvStage>
  )
}

// A spawn grows out of its parent's place, and an archive shrinks back into it: the child mounts,
// or goes, after a moment. Its exit is given where the parent stands, as the view gives it.
function Lifecycle({ leave }: { leave: boolean }) {
  // A spawn is not there at first and mounts; an archive is there at first and goes.
  const [shown, setShown] = useState(leave)
  useEffect(() => { const t = setTimeout(() => setShown(!leave), leave ? 900 : 500); return () => clearTimeout(t) }, [leave])
  const child = model(worker('cd-kid', 'fixture-kid', 'cd-dev', { harness: 'opencode', model: 'openrouter/fixture/flash', activity: 'working', cost: cost(0.1) }), { short: 'kid' })
  const parent = model(DEV, { it: WORK, owns: 1, badges: AT_RISK })
  return (
    <SvStage height={heightOf(2)}>
      {(px) => {
        const at = place(px, 0), below = place(px, 1)
        // Given where the parent stands, as the view gives it.
        const exit: Exit = { to: () => at, morph: null }
        return <>
          <SystemCard m={parent} sig={cardSig(parent)} place={at} selected={false} enter={null} jump={false} far="" />
          <AnimatePresence initial={false} custom={exit}>{shown ? <SystemCard key={child.id} m={child} sig={cardSig(child)} place={below} selected={false} enter={leave ? null : at} jump={false} far="" /> : null}</AnimatePresence>
        </>
      }}
    </SvStage>
  )
}

export const stories: Story[] = [{
  name: 'System card',
  group: 'System view',
  what: 'One agent as an instrument tile on the system view\'s Tree and Cards layouts, and the phone\'s Tree and Cards, where it stays a full card at any zoom. Row 1 is its harness mark in a state ring, its name, its model and its cost (its own; on hover, its whole tree\'s). Row 2 is the ITSA it owns: the status mark, key and title, a roll-up of how many child ITSAs are done, and how many more it owns. Row 3 is that ITSA\'s Work columns as badges (health when it isn\'t on track, review and tests, and fields set to show as chips). Row 4 is what the agent is doing. A hairline along the foot is its context against the compaction limit. The human gets a card too, headed You. Unread mail stacks against the top-right corner, a manager has a fold control, and zoomed far out the card is a chip.',
  when: 'Drawn once per agent by the system view (`w:system`, in the Tree and Cards layouts) for each card near the viewport; the human\'s card is always the root. It is memoised on a signature of what it shows, so a poll that changes one agent redraws one card. These states draw it alone on the view\'s stage, with the motion tokens the view reads.',
  code: ['web/src/system/SystemCard.tsx#SystemCard', 'web/src/system/SystemCard.tsx#Stack'],
  rules: [
    'The mark is the harness hue inside a state ring on the status vocabulary; the model is a neutral badge; Work badges use the status tones (' + ds('In stam') + ').',
    'A card is `--sv-card-w` wide (`--size-card`) and `--sv-card-h` tall; its name is the one button that opens the details, and a click anywhere else on the card does the same. The stack and the fold control are buttons of their own, and the card is a group, not a button.',
    'Unread mail is drawn as up to four sheets (`STACK_MAX`) and the count. A new mail drops a sheet on top and bumps the count with a stamp; a read slips the top sheet into the card as the count stamps. The human\'s stack and its words take the warning hue.',
    'A card that just got mail keeps a mark on its hairline for `--duration-mark`: the accent, or the warning colour for the human and for an ask. Under reduced motion this mark is what shows instead of a flight.',
    'A status change on the same ITSA stamps its mark once: from scale 1.15 with a slight turn to rest, on a spring (bounce 0.2, 1.5 slows), and washes the row with the accent\'s subtle fill, fading by opacity alone. The roll-up stamps as it advances. Cost and counts roll in tabular figures, and a growing cost raises a "+$" that fades.',
    'A spawn grows out of its parent\'s place from scale 0.96 and opacity 0 (never `scale(0)`), on a spring with bounce 0.15 over 2.5 slows. A far chip (zoomed out) fades in and out without the scale, so its name never draws under 14 px. An archive shrinks back toward its nearest card still shown, with no bounce, over 1.5 slows, and fades. A layout change glides the card on a spring (bounce 0.1, 2 slows). All of it is `transform` and `opacity`.',
    'The context hairline is `--border-strong` at rest, the warning colour (`--st-blocked`) at the daemon\'s first context level, and the error colour (`--st-errored`) at the second; its length changes over `--duration-tick`.',
    'Far out (below zoom 0.8) the card draws only its chip: mark, name, unread, the ITSA and its activity as room allows, at screen size; the name button stays for the keyboard.',
  ],
  states: [
    { name: 'An agent at work', data: { itsaStatuses: STATUSES }, render: () => <Cards ms={[model(DEV, { it: WORK, owns: 2, badges: AT_RISK, unread: 2, ctx: 0.62, ctxLevel: 1, rollup: { done: 1, total: 4 } })]} /> },
    {
      name: 'Each harness and state', data: { itsaStatuses: STATUSES },
      render: () => <Cards ms={[
        model(worker('cd-a', 'fixture-claude', 'cd-cos', { activity: 'working', cost: cost(1.4), context_tokens: 200000 }), { it: itsa({ id: 'ci-a', key: 'FX-1', title: 'A Claude Code agent, working', owner: 'cd-a' }), owns: 1, ctx: 0.4 }),
        model(worker('cd-b', 'fixture-codex', 'cd-cos', { harness: 'codex', model: 'gpt-6.1-sol', activity: 'waiting', activity_detail: 'Waiting for 4 min', cost: cost(0.8) }), { it: itsa({ id: 'ci-b', key: 'FX-2', title: 'A Codex agent, waiting', owner: 'cd-b', status: 'in_review' }), owns: 1, ctx: 0.18 }),
        model(worker('cd-c', 'fixture-opencode', 'cd-cos', { harness: 'opencode', model: 'openrouter/fixture/flash', activity: 'blocked', activity_detail: 'Waiting for your answer', cost: cost(0.3) }), { it: itsa({ id: 'ci-c', key: 'FX-3', title: 'An OpenCode agent, blocked on you', owner: 'cd-c', status: 'needs_approval' }), owns: 1, ctx: 0.08 }),
        model(worker('cd-d', 'fixture-broken', 'cd-cos', { harness: 'codex', model: 'gpt-6.1-sol', activity: 'errored', cost: cost(0.1) }), { ctx: 0.97, ctxLevel: 2 }),
        model(worker('cd-e', 'fixture-paused', 'cd-cos', { harness: 'opencode', model: 'openrouter/fixture/flash', lifecycle: 'paused', activity: null }), {}),
      ]} />,
    },
    { name: 'You, the human', data: { itsaStatuses: STATUSES }, render: () => <Cards ms={[model(null, { unread: 3, badges: [{ kind: 'word', id: 'waiting', word: '1 waiting on you', tone: 'warn', title: 'Asks, decisions, and ITSAs waiting on you' }] })]} /> },
    { name: 'A manager and its fold', data: { itsaStatuses: STATUSES }, render: () => <Cards ms={[model(TREE, { it: itsa({ id: 'ci-m', key: 'FX-9', title: 'Fixture project', owner: 'cd-lead' }), owns: 1, kids: 4, rollup: { done: 2, total: 5 } }), model(worker('cd-folded', 'fixture-folded', 'cd-cos', { role: 'manager', activity: 'working', cost: cost(0.9, 4.2) }), { folded: { n: 5, states: [{ state: 'working', n: 3 }, { state: 'idle', n: 1 }, { state: 'blocked', n: 1 }] }, unread: 4 })]} /> },
    { name: 'Mail just landed', data: { itsaStatuses: STATUSES }, render: () => <Cards ms={[model(DEV, { it: WORK, owns: 1, unread: 3, hit: 'mail' }), model(null, { unread: 1, hit: 'warn', badges: [{ kind: 'word', id: 'waiting', word: '1 waiting on you', tone: 'warn', title: 'Asks, decisions, and ITSAs waiting on you' }] })]} /> },
    { name: 'Selected', data: { itsaStatuses: STATUSES }, render: () => <Cards ms={[model(DEV, { it: WORK, owns: 1, ctx: 0.4 })]} selected="cd-dev" /> },
    { name: 'Far out, as chips', data: { itsaStatuses: STATUSES }, render: () => <Cards far="chip" ms={[model(DEV, { it: WORK, owns: 1, unread: 2 }), model(worker('cd-wait', 'fixture-waiter', 'cd-cos', { harness: 'codex', activity: 'blocked' }), { unread: 1 })]} /> },
    {
      name: 'Unread arrives, then is read', data: { itsaStatuses: STATUSES },
      render: () => <Later after={500}>{(late) => <Later after={1800}>{(later) => <Cards ms={[model(DEV, { it: WORK, owns: 1, unread: later ? 1 : late ? 3 : 1 })]} />}</Later>}</Later>,
    },
    {
      name: 'A status changes', data: { itsaStatuses: STATUSES },
      render: () => <Later after={500}>{(late) => <Cards ms={[model(DEV, { it: late ? { ...WORK, status: 'in_review' } : WORK, owns: 1, rollup: { done: late ? 2 : 1, total: 4 } })]} />}</Later>,
    },
    {
      name: 'Spend grows', data: { itsaStatuses: STATUSES },
      render: () => <Later after={500}>{(late) => <Cards ms={[model(late ? { ...DEV, cost: cost(3.1) } : DEV, { it: WORK, owns: 1 })]} />}</Later>,
    },
    { name: 'A spawn', data: { itsaStatuses: STATUSES }, render: () => <Lifecycle leave={false} /> },
    { name: 'An archive', data: { itsaStatuses: STATUSES }, render: () => <Lifecycle leave /> },
    { name: 'No ITSA, no cost yet', data: { itsaStatuses: STATUSES }, render: () => <Cards ms={[model(agent({ id: 'cd-new', name: 'fixture-new', parents: ['cd-cos'] }), { short: 'new' })]} /> },
  ],
}]
