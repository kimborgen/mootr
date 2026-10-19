import { OnMount, Row } from '../stories/helpers'
import { itsa, itsaData, STATUSES, TREE } from '../stories/itsaFixtures'
import { byName } from '../stories/fixtures'
import { ds, type Story } from '../stories/types'
import { showMenu } from '../ui/menu'
import { ownerMenu, PersonGlyph, RollupBar, StatusGlyph, statusMenu } from './itsa'

const data = itsaData(TREE)
const glyphs = (names: string[]) => <Row items={names.map((n) => ({ label: n.replace(/_/g, ' '), node: <StatusGlyph status={n} /> }))} />
const bar = (r: Partial<Record<'backlog' | 'ready' | 'active' | 'review' | 'closed', number>>, wide?: boolean) => <RollupBar r={{ backlog: 0, ready: 0, active: 0, review: 0, closed: 0, ...r }} wide={wide} />
const open = (items: Parameters<typeof showMenu>[2]) => (el: HTMLElement) => { const b = el.querySelector('button')!; const r = b.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, items, b) }
const trigger = <button className="btn" type="button">Open the menu</button>

export const stories: Story[] = [{
  name: 'ITSA status glyph',
  group: 'ITSA and work',
  what: 'The mark of an ITSA\'s status: a ring whose shape says the category (dashed for backlog, plain for ready, half filled for active, three quarters filled for review, a tick for the first closed status, a cross for the other closed ones) and whose colour says the tone. The words always sit beside it or in its title, so colour is never the only channel.',
  when: 'Before every ITSA row and card: the Issues list in the sidebar, the Board, the ITSA view\'s header, breadcrumbs and children, the Work table\'s Status column, the waiting list, an `S-N` key in mail, and the status picker.',
  code: ['web/src/itsa/itsa.tsx#StatusGlyph', 'web/src/itsa/itsa.tsx#toneOf', 'web/src/itsa/itsa.tsx#statusInfo'],
  rules: [
    'The glyph is `--icon-xs` (14 px) square. Its tone is `--is-*` from `web/tokens-stam.css`, one per category (' + ds('In stam') + ').',
    'Tones: backlog `--is-backlog` (muted), ready `--is-ready` (secondary), active and review `--is-active` and `--is-review` (the working tone), the first closed status `--is-done`, every other closed status `--is-closed` (muted).',
    'A status that waits on the human, and `blocked`, take `--is-waiting` (the blocked tone) whatever their category, as a blocked agent does; the shape still says the category.',
    'A status the settings no longer know draws as backlog (`statusInfo`), so an old ITSA never shows nothing.',
    'It is an image with the status name as its label; where a `title` is given, hover shows it.',
  ],
  states: [
    { name: 'Backlog and ready', data, render: () => glyphs(['idea', 'backlog', 'todo']) },
    { name: 'Active and review', data, render: () => glyphs(['in_progress', 'in_review', 'ready_to_merge']) },
    { name: 'Closed: done, then the others', data, render: () => glyphs(['done', 'canceled', 'wont_do']) },
    { name: 'Waiting on the human, and blocked', data, render: () => glyphs(['needs_input', 'needs_approval', 'blocked']) },
    { name: 'A status the settings dropped', data, render: () => glyphs(['renamed_since']) },
    { name: 'Every status', data, render: () => glyphs(STATUSES.map((s) => s.name)) },
  ],
}, {
  name: 'ITSA roll-up bar',
  group: 'ITSA and work',
  what: 'A thin bar that says how far an ITSA\'s children have got: the closed share in one tone, the active and review share (work in flight) in another, the rest as the empty track. The title and the accessible label spell the counts out ("3 of 8 closed · 2 backlog, 1 ready, 1 active, 1 review, 3 closed").',
  when: 'On an Issues row with children, on a Board card with children, beside each child in the ITSA view\'s Children list (small), and in the Children heading (wide). It renders nothing for an ITSA with no children.',
  code: ['web/src/itsa/itsa.tsx#RollupBar', 'web/src/itsa/itsa.tsx#rollupOf', 'web/src/itsa/itsa.tsx#rollupText'],
  rules: [
    'The bar is 28 px wide and 4 px tall, 96 px when wide, on a `--radius-xs` track (`--status-neutral-bg`); on a phone an Issues row\'s bar is 36 px (`.rollup` in `web/style.css`).',
    'Closed children fill with `--st-idle`, active and review with `--st-working`; backlog and ready children are left as the track.',
    'Counts are direct children only, by category; the text starts "N of M closed" so it reads the same without the colours (' + ds('State vocabulary') + ').',
  ],
  states: [
    { name: 'Part way', render: () => bar({ closed: 3, active: 1, review: 1, backlog: 2, ready: 1 }) },
    { name: 'Wide, as in the Children heading', render: () => bar({ closed: 3, active: 1, review: 1, backlog: 2, ready: 1 }, true) },
    { name: 'All closed', render: () => bar({ closed: 6 }) },
    { name: 'Nothing started', render: () => bar({ backlog: 4, ready: 2 }) },
    { name: 'No children, so nothing shows', render: () => <p className="muted">Nothing between the lines:{bar({})}</p> },
  ],
}, {
  name: 'ITSA owner mark',
  group: 'ITSA and work',
  what: 'Who owns or takes part in an ITSA: an agent\'s harness mark with its state ring, the human\'s user icon, a dashed ring for nobody, and a bot icon for an agent the list no longer has.',
  when: 'In the Board card\'s foot, the ITSA view\'s header and Participants, the thread\'s events, the Children list, and the owner picker.',
  code: ['web/src/itsa/itsa.tsx#PersonGlyph', 'web/src/itsa/itsa.tsx#personName'],
  rules: [
    'An agent\'s mark is the agent mark with its state ring, so the colour of the ring is the agent\'s state (' + ds('State vocabulary') + '); see the agent mark story.',
    'The human shows the `user` icon and the name "You" in the owner menu; nobody shows a dashed ring and the words "No owner".',
    'The mark has no name of its own: a title or a label beside it carries the owner\'s name.',
  ],
  states: [
    { name: 'Each harness, the human, nobody, and an unknown id', render: () => (
      <Row items={[
        { label: 'claude', node: <PersonGlyph id={byName('fixture-dev').id} /> },
        { label: 'codex', node: <PersonGlyph id={byName('fixture-review').id} /> },
        { label: 'opencode', node: <PersonGlyph id={byName('fixture-ops').id} /> },
        { label: 'human', node: <PersonGlyph id="human" /> },
        { label: 'nobody', node: <PersonGlyph id={null} /> },
        { label: 'unknown agent', node: <PersonGlyph id="forgotten-agent" /> },
      ]} />) },
  ],
}, {
  name: 'ITSA status and owner menus',
  group: 'ITSA and work',
  what: 'The two pickers that change an ITSA as the human. The status menu lists every status under its category, ticks the current one, and marks the statuses that wait on you. The owner menu lists You, No owner, then every running agent by name.',
  when: 'From the status and owner buttons in the ITSA view\'s header. It is a menu on a desktop and a sheet on a phone. A pick shows at once (the ITSA is "saving…") and rolls back with a notice if the daemon refuses.',
  code: ['web/src/itsa/itsa.tsx#statusMenu', 'web/src/itsa/itsa.tsx#ownerMenu', 'web/src/itsa/itsa.tsx#setItsa'],
  rules: [
    'It is the one context menu (see the Context menu story): `--size-row-menu` rows on a desktop, `--size-hit-touch` on a phone (' + ds('Modals and menus') + ').',
    'Sections are the category names (Backlog, Ready, Active, Review, Closed); a status that waits on you carries the hint "waits on you".',
    'The owner menu lists only live agents that are not assistants; an owner that has stopped still shows, ticked, so the pick is not lost.',
  ],
  states: [
    { name: 'Status menu', data, height: 520, render: () => <OnMount run={open(statusMenu(itsa(912, 911, 'Fixture tokenizer', 'in_review'), undefined))}>{trigger}</OnMount> },
    { name: 'Owner menu', data, height: 420, render: () => <OnMount run={open(ownerMenu(itsa(912, 911, 'Fixture tokenizer', 'in_review', { owner: 'fx-review' })))}>{trigger}</OnMount> },
  ],
}]
