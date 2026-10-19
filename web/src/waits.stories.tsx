import { AGENTS, agent } from './stories/fixtures'
import { Row } from './stories/helpers'
import { ds, type Story } from './stories/types'
import type { Resting, Wait } from './types'
import { Tab } from './shell/Tab'
import { ItsaChips, RestBadge, WaitBadges, WaitMark, WaitThinBar } from './waits'
import { itsa, STATUSES } from './stories/itsaFixtures'

const w = (kind: string, o: Partial<Wait> = {}): Wait => ({ id: 'sw-' + kind, kind, since: '2026-10-01T09:00:00.000Z', source: 'wait_for', ...o })
const KINDS: Wait[] = [
  w('agent', { target: 'fx-cos' }), w('children', { detail: '2 children' }), w('job', { detail: 'job npm test' }),
  w('timer', { until: new Date(Date.now() + 4 * 60000).toISOString() }), w('event', { detail: 'github checks' }), w('human', { target: 'perm-x' }),
]
const waiter = (ws: Wait[], o = {}) => agent({ id: 'wx', name: 'fixture-waiter', activity: 'waiting', waits: ws, ...o })
// A tab of the fixture waiter `wx`, with its wait badges in the chips slot. `width` makes it tight:
// its badges fold when they can't sit beside the name (S-1659). Each state has its own key `k`.
const TabOf = ({ title = 'fixture-waiter', width, k = 'agent:wx' }: { title?: string; width?: number; k?: string }) => (
  <div className="tabs" style={{ width }}><Tab id={k} active title={title} glyph={null} chips={<WaitBadges id="wx" tabKey={k} />} onSelect={() => {}} /></div>
)
// A resting agent (S-2110): paused with its session kept, and the daemon's `resting` field.
const rest = (o: Partial<Resting> = {}): Resting => ({ reason: 'wait', waits: [{ id: 'rw1', kind: 'event', target: null, detail: 'PR #12', since: '2026-10-01T09:00:00.000Z', until: null }], expected_wake: new Date(Date.now() + 3 * 3600_000).toISOString(), ...o })
const sleeper = (r: Resting, o = {}) => agent({ id: 'wx', name: 'fixture-waiter', lifecycle: 'paused', activity: null, resting: r, ...o })
const asleep = (r: Resting) => ({ agents: [...AGENTS, sleeper(r)] })
const on = (ws: Wait[]) => ({ agents: [...AGENTS, waiter(ws, { lifecycle: 'active' })] })

export const stories: Story[] = [{
  name: 'Wait mark',
  group: 'Primitives',
  what: 'What a waiting agent waits for, said short: an icon per kind (a reply, children, a job, a timer with time left, an external event), or the warning badge when it waits on you. On an agent\'s tab the same waits are badges, one per kind: an icon and a count, or the time left for a timer (`4m`, then `45s`). On a desktop a badge with a place to go (the agent or the request) opens it when clicked; on a phone badges only inform.',
  when: "After a live agent's name in the tree (its top wait); the agent's tab (WaitBadges) while it waits; the tooltip lists every wait. Ranked as the daemon ranks them, so the first wait is the one its state names.",
  code: ['web/src/waits.tsx#WaitMark', 'web/src/waits.tsx#RestBadge', 'web/src/waits.tsx#restText', 'web/src/waits.tsx#WaitBadges', 'web/src/waits.tsx#WaitThinBar', 'web/src/waits.tsx#WaitLink', 'web/src/waits.tsx#countdown', 'web/src/waits.tsx#waitLabel', 'web/src/waits.tsx#WAIT_ICON'],
  rules: [
    'A resting agent (its harness stopped, its session kept) takes the resting badge instead: the moon, what it waits for and `wakes ~14:20` in the viewer\'s own clock (`Tue 14:20` on another day), in `--text-secondary` with tabular figures. With no known wake time only the wait shows; with no wait it says `idle`. The tree row, the tab and the Work table\'s agent chip show the wake time alone (`~14:20`) and keep the full line in the tooltip and `aria-label`; the details page and the system view\'s agent panel show it whole, wrapping inside the badge. A tab fits it like any badge: the wake time, then the mark alone when the name would be squeezed, then nothing in the strip with the active tab\'s thin bar carrying it.',
    'The mark is `--text-muted` at `--icon-xs` with tabular figures for the time left; a wait on the human is as loud as the approval badge (`--status-warning-bg`), and adds nothing when that badge already shows.',
    'Colour is never the only channel: each kind has its own icon (' + ds('State vocabulary') + ').',
    'A tab badge is `--text-muted` at `--icon-xs` (the warning colours for a wait on the human); every badge has a tooltip and an `aria-label` naming its wait, and a click on one never selects the tab. One shared ticker redraws every countdown each second, without motion.',
    'A tight tab folds its badges into one, the total with the top wait\'s icon, when the per-kind badges would leave the name under `--size-tab-name-min`; the combined badge opens a popover of the waits on a desktop (Escape or a press outside closes it). When even the one badge leaves no room, the strip shows the name and icon only, and the active tab\'s thin bar holds the badges, at `--size-tab-bar-thin` (18 px), The thin bar holds waits and the tab\'s ITSA chips (S-1452) only: a view\'s Reconnecting is its own line at the foot of the conversation (OwnView), on a desktop and a phone, so one view shows it once.',
  ],
  states: [
    { name: 'Each kind in the tree', render: () => <Row items={KINDS.map((k) => ({ label: k.kind, node: <WaitMark a={waiter([k])} /> }))} /> },
    { name: 'On a fixture agent', render: () => <Row items={AGENTS.filter((a) => a.waits?.length).map((a) => ({ label: a.name, node: <WaitMark a={a} /> }))} /> },
    { name: 'Tab, each kind', data: on(KINDS), render: () => <TabOf /> },
    { name: 'Tab, a timer', data: on([KINDS[3]]), render: () => <TabOf /> },
    { name: 'Tab, a count', data: on([w('children', { id: 'c1', detail: 'a' }), w('children', { id: 'c2', detail: 'b' })]), render: () => <TabOf /> },
    { name: 'Tab, long title', data: on(KINDS), render: () => <TabOf title="fixture-waiter-with-a-very-long-name" /> },
    { name: 'Tab, folded', data: on(KINDS), render: () => <TabOf width={150} k="agent:wx#folded" /> },
    { name: 'Resting badge', render: () => <Row items={[
      { label: 'wait and wake', node: <RestBadge a={sleeper(rest())} /> },
      { label: 'no expected wake', node: <RestBadge a={sleeper(rest({ expected_wake: null }))} /> },
      { label: 'idle', node: <RestBadge a={sleeper(rest({ reason: 'idle', waits: [], expected_wake: null }))} /> },
      { label: 'compact', node: <RestBadge a={sleeper(rest())} mode="compact" /> },
    ]} /> },
    { name: 'Tab, resting', data: asleep(rest()), render: () => <TabOf k="agent:wx#resting" /> },
    { name: 'Thin bar, squeezed', data: on(KINDS), render: () => <><TabOf width={96} k="agent:wx#squeezed" /><WaitThinBar k="agent:wx#squeezed" /></> },
    { name: 'Tab, resting, tight', data: asleep(rest()), render: () => <TabOf width={96} k="agent:wx#rest-tight" /> },
  ],
}]

// A tab of the fixture agent `wx` that owns ITSAs: chips after any wait badges. `width` makes it tight.
const owned = (...xs: ReturnType<typeof itsa>[]) => ({ agents: [...AGENTS, waiter([], { lifecycle: 'active' })], itsas: xs.map((x) => ({ ...x, owner: 'wx' })), itsaStatuses: STATUSES })
const ChipTab = ({ width = 420, k = 'agent:wx', waits = false }: { width?: number; k?: string; waits?: boolean }) => (
  <div className="tabs" style={{ width }}><Tab id={k} active title="fixture-waiter" glyph={null} chips={<>{waits ? <WaitBadges id="wx" tabKey={k} /> : null}<ItsaChips id="wx" tabKey={k} /></>} onSelect={() => {}} /></div>
)
const PROJECT = itsa(1426, null, 'Desktop UX', 'in_progress')
const MANY = [itsa(1452, null, 'Agent tab ITSA links', 'in_progress'), itsa(1453, null, 'Tab drag order', 'needs_input'), itsa(1454, null, 'Phone strip', 'in_review')]

stories.push({
  name: 'Agent tab ITSA chips',
  group: 'Tree and shell',
  what: "The links on an agent's tab to the ITSAs it owns at the top (S-1452): a chip with the status glyph and the key (`S-1426`), the title in the tooltip. A click opens that ITSA and never selects the tab. Several at the same top level sit side by side while they fit; when they don't, they fold into one pill, `N ITSAs`, whose popover lists them.",
  when: "On the tab of an agent that owns an ITSA that isn't closed. An agent that owns a project and issues under it shows the project only; one that owns none shows nothing. After the tab's wait badges, which keep their room first.",
  code: ['web/src/waits.tsx#ItsaChips', 'web/src/waits.tsx#WaitThinBar', 'web/src/waits.tsx#PopPortal', 'web/src/itsa/itsa.tsx#topOwned'],
  rules: [
    'Which ITSAs: owned, not closed, with no owned open ancestor; a closed ancestor hides nothing.',
    'A chip is the tree\'s `.ichip` (`--text-secondary` on `--status-neutral-bg`, the warning colours for a status that waits on you) at `--type-chrome-xs`; its tooltip and `aria-label` read `key title · status`.',
    'A click, a press, a middle click and a menu on a chip never reach the tab: no select, no close. The pill opens the same popover as the folded wait badge (Escape or a press outside closes it, and Escape returns focus to the pill); a lone ITSA is always a chip.',
    'The chips give way: they fold when the name would fall under `--size-tab-name-min`, and when even the pill does not fit they go to the active tab\'s thin bar, with the waits there.',
    'On a phone the chip fills the tab bar\'s height (44 px, `--size-hit-touch`) so it is a touch target; the pill takes a tap and opens the same popover, where the wait badges only inform.',
  ],
  states: [
    { name: 'No ITSAs', data: owned(), render: () => <ChipTab k="agent:wx#none" /> },
    { name: 'One ITSA', data: owned(PROJECT), render: () => <ChipTab k="agent:wx#one" /> },
    { name: 'A project and its issues', data: owned(PROJECT, itsa(1427, 1426, 'Tabs', 'in_progress'), itsa(1428, 1427, 'Tab fit', 'in_progress')), render: () => <ChipTab k="agent:wx#chain" /> },
    { name: 'Several that fit', data: owned(...MANY), render: () => <ChipTab width={520} k="agent:wx#fit" /> },
    { name: 'Several, folded into the pill', data: owned(...MANY), render: () => <ChipTab width={190} k="agent:wx#pill" /> },
    { name: 'Beside wait badges', data: { ...owned(...MANY), agents: [...AGENTS, waiter(KINDS.slice(1, 4), { lifecycle: 'active' })] }, render: () => <ChipTab width={400} waits k="agent:wx#waits" /> },
    { name: 'On a phone', data: owned(...MANY), render: () => <div style={{ width: 360 }}><ChipTab width={360} k="agent:wx#phone" /></div> },
  ],
})
