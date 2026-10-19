import { hash } from '../api'
import * as shell from '../shell/layout'
import { patchAgent, patchItsa, Scene, systemData, USAGE_ROUTES, withAgent, worker, cost, ensureDebug, type Act } from '../stories/system'
import { reply, ds, type Story } from '../stories/types'
import { SystemView } from './SystemView'

// The mode a state opens in comes from a link's `#view=system&mode=…`, which the app reads once, as
// the view mounts; a state says it outright so one never inherits the last.
const view = (mode: 'tree' | 'cards' | 'stars') => {
  hash.set('mode', mode)
  ensureDebug()
  // The view fetches usage only while its key is a tab the shell shows.
  if (!shell.leaves(shell.mainWorld().root).some((l) => l.active === 'system')) shell.setLayout(shell.leaf(['system']), 'system')
  return <SystemView viewKey="system" />
}
const scene = (mode: 'tree' | 'cards' | 'stars', act?: (a: Act) => Promise<void>, height = 820) => <Scene act={act} height={height}>{view(mode)}</Scene>
const q = <T extends Element>(sel: string) => document.querySelector<T>(sel)

// Types into the Find box the way a keyboard does, through the input's own value setter.
const type = (input: HTMLInputElement, text: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const press = (label: string) => [...document.querySelectorAll<HTMLElement>('.sv-modes button')].find((b) => b.textContent === label)?.click()

export const stories: Story[] = [{
  name: 'System view',
  group: 'System view',
  what: 'The whole stam system on one page. A header of instruments (agents by state, ITSAs active, in review and done today, the subscription windows, the day\'s spend), then the org tree of agents as cards with a wire from each parent to its children. A card is an agent: its mark, name, model and cost, the ITSA it owns, that ITSA\'s Work badges, what it is doing, and a hairline of its context. Unread mail stacks on a card\'s corner, and mail flies between cards. The header\'s switch lays the same cards out as the Tree, as Cards on orbits round the chief of staff, or as Stars, orbs sized by spend. Clicking a card opens its details beside the picture (a bottom sheet on a phone), with links to the agent\'s world, conversation, terminal and ITSA.',
  when: 'The `w:system` view of the main world (`#view=system`), opened from the world\'s tab. A link can pick the layout (`#view=system&mode=cards`); otherwise the layout is the last one chosen on this kind of screen. A pane narrower than 600 px (`NARROW_BELOW`) draws the Tree as it is on a desktop, branching top-down on wires, as the same full cards the phone\'s Cards shows at any zoom; it opens at a readable zoom with cos at the top centre and you pan and zoom the canvas (pinch, double tap, − and +). The 360 px frames are that. It reads the agents, ITSAs and statuses from the store, the live stream\'s mail events, and `GET /api/usage` for the header while its tab is shown.',
  code: ['web/src/system/SystemView.tsx#SystemView', 'web/src/system/SystemView.tsx#NARROW_BELOW'],
  rules: [
    'Calm at rest: nothing moves, pulses or spins while the system is quiet, and every motion shows one real event (mail sent, a spend, a status change, a spawn, an archive). The view is exempt from the usual motion rules (' + ds('In stam') + '), and follows `.claude/skills/system-view-motion`.',
    'Motion is `transform` and `opacity`, placed by Motion on springs whose lengths are shares of `--duration-slow`; a mail flight is 400 to 880 ms by distance (`--duration-flight` is the longest hop, four slows), and a roll takes `--duration-tick` (two slows), and a count bump or a stack sheet landing takes `--duration-slow`. Reduced motion zeroes these tokens, so every change is instant, except a mode switch, which crossfades the old picture into the new over `--duration-crossfade` (220 ms) instead of moving anything. A card that got mail keeps a mark for `--duration-mark` instead of a flight.',
    'Every card, wire and sheet is keyed by its agent or mail, so the same object moves: a layout change glides cards to their new places, a spawn grows out of its parent, an archive shrinks back into its nearest card still shown.',
    'The mark is the harness hue (`--h-claude`, `--h-codex`, `--h-opencode`) inside a state ring in the status vocabulary: working `--st-working`, idle `--st-idle`, blocked `--st-blocked`, errored `--st-errored`, paused `--st-paused`, resting `--st-resting` (its card\'s panel adds the resting badge: what it waits for and when it wakes). A colour is never the only channel: the state is in the card\'s label too (' + ds('In stam') + ').',
    'A card is `--size-card` wide (the pane minimum less the `space-6` gutter). The pan and zoom run from 0.35 to 2, Fit returns to the whole picture, and below 0.8 a card draws as a chip at screen size so its name stays readable.',
    'Past 60 agents the desktop folds the managers; the phone always folds those below the first level. A manager stays open while it, or anyone under it, is blocked, errored, or has an ITSA waiting on the human. A fold control shows how many agents it hides, with a dot per state.',
    'On a phone the header keeps the agent counts and the day\'s spend; the switch, Fit and Find sit on a row of their own at `--size-hit-touch`, and a far card or an orb keeps a finger-sized hit area however far out. Double-tap zooms in by 2, and at the most zoom returns to Fit.',
    'A window meter turns to the warning colour at 80% or more. The window meters sit in the header, one 5-hour and one weekly per account; the weekly ones go at 1440 px and narrower. Below 1280 px each account\'s 5-hour meter shows its harness mark, in the harness hue, in place of the name, with the name as its title and label; a narrower pane still wraps them onto a second row, with Find, the switch and Fit kept together at its right end and the separators hidden. The day\'s spend carries a sparkline of the last 14 days on a desktop.',
  ],
  states: [
    { name: 'Small system', data: systemData('small'), routes: USAGE_ROUTES, render: () => scene('tree') },
    { name: 'Large system', data: systemData('large'), routes: USAGE_ROUTES, render: () => scene('tree', undefined, 900) },
    { name: 'Cards on orbits', data: systemData('small'), routes: USAGE_ROUTES, render: () => scene('cards') },
    { name: 'Stars by spend', data: systemData('large'), routes: USAGE_ROUTES, render: () => scene('stars', undefined, 900) },
    {
      name: 'A card selected', data: systemData('small'), routes: USAGE_ROUTES,
      render: () => scene('tree', async (a) => { if (await a.drawn()) q<HTMLElement>('[data-card="sv-dev"]')?.click() }),
    },
    {
      name: 'Mail in flight', data: systemData('small'), routes: USAGE_ROUTES,
      render: () => scene('tree', async (a) => {
        if (!(await a.drawn())) return
        // A reply down a wire, a mail across the tree, and an ask to you (the sheet turns warning).
        a.mail('fm-1', 'sv-cos', ['sv-dev'])
        a.mail('fm-2', 'sv-dev', ['sv-review'])
        a.mail('fm-3', 'sv-ops', ['human'], true)
        patchAgent('sv-dev', { unread: 3 })
        patchAgent('sv-review', { unread: 2 })
      }),
    },
    {
      name: 'Spawn', data: systemData('small'), routes: USAGE_ROUTES,
      render: () => scene('tree', async (a) => {
        if (!(await a.drawn())) return
        await a.wait(300)
        withAgent(worker('sv-new', 'fixture-fresh', 'sv-dev', { harness: 'opencode', model: 'openrouter/fixture/flash', activity: 'working', cost: cost(0) }))
      }),
    },
    {
      name: 'Archive', data: systemData('small'), routes: USAGE_ROUTES,
      render: () => scene('tree', async (a) => {
        if (!(await a.drawn())) return
        await a.wait(300)
        patchAgent('sv-paused', { lifecycle: 'archived' })
      }),
    },
    {
      name: 'An ITSA done', data: systemData('small'), routes: USAGE_ROUTES,
      render: () => scene('tree', async (a) => {
        if (!(await a.drawn())) return
        await a.wait(300)
        patchItsa('si-2', { status: 'done', closed_at: new Date().toISOString() })
      }),
    },
    {
      name: 'Spend grows', data: systemData('small'), routes: USAGE_ROUTES,
      render: () => scene('tree', async (a) => {
        if (!(await a.drawn())) return
        await a.wait(300)
        patchAgent('sv-dev', { cost: cost(3.1) })
      }),
    },
    {
      name: 'Mode changes', data: systemData('small'), routes: USAGE_ROUTES,
      render: () => scene('tree', async (a) => {
        if (!(await a.drawn())) return
        await a.wait(400)
        press('Cards')
        await a.wait(1400)
        press('Stars')
      }),
    },
    {
      name: 'Find', data: systemData('large'), routes: USAGE_ROUTES,
      render: () => scene('tree', async (a) => {
        if (!(await a.drawn())) return
        q<HTMLElement>('.sv-find-btn')?.click()
        await a.wait(100)
        const input = q<HTMLInputElement>('.sv-find input')
        if (input) type(input, 'search')
      }, 900),
    },
    { name: 'No agents yet', data: { ...systemData('small'), agents: [], itsas: [], attention: [] }, routes: USAGE_ROUTES, render: () => scene('tree') },
    { name: 'Agents loading', data: { ...systemData('small'), loaded: { agents: false, mail: true, itsas: true } }, routes: USAGE_ROUTES, render: () => scene('tree') },
    {
      name: 'A resting card selected', routes: USAGE_ROUTES,
      data: (() => { const d = systemData('small'); return { ...d, agents: (d.agents ?? []).map((a) => (a.id === 'sv-dev' ? { ...a, lifecycle: 'paused', activity: null, resting: { reason: 'wait' as const, waits: [{ id: 'rw', kind: 'event', target: null, detail: 'PR #1234 checks and review from the fixture-reviewer-with-a-very-long-name, then the merge queue', since: '2026-10-01T09:00:00.000Z', until: null }], expected_wake: '2026-10-30T14:20:00.000Z' } } : a)) } })(),
      render: () => scene('tree', async (a) => { if (await a.drawn()) q<HTMLElement>('[data-card="sv-dev"]')?.click() }),
    },
    { name: 'No usage yet', data: systemData('small'), routes: { 'GET /api/usage': reply(503, { error: 'fixture: usage unreachable' }) }, render: () => scene('tree') },
  ],
}]
