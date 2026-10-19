import { Glyph } from '../Glyph'
import { Icon } from '../Icon'
import { byName } from '../stories/fixtures'
import { holdTimers, OnMount } from '../stories/helpers'
import { ds, type Story } from '../stories/types'
import { showMenu, toast, type MenuItem } from './menu'

const AGENT_MENU: MenuItem[] = [
  { section: 'fixture-dev' },
  { label: 'Open', icon: 'terminal', hint: 'Enter' },
  { label: 'Pause', icon: 'pause' },
  { label: 'Disabled while paused', icon: 'play', disabled: true },
  'sep',
  { section: 'View' },
  { label: 'Terminal', checked: false },
  { label: 'Conversation', checked: true },
  'sep',
  { label: 'Shut down', icon: 'power', danger: true },
]
const AGENTS: MenuItem[] = [{ section: 'Open as a tab' }, ...['fixture-dev', 'fixture-review', 'fixture-ops'].map((n) => ({ label: n, glyph: <Glyph agent={byName(n)} /> }))]
const LONG: MenuItem[] = [{ section: 'Owned ITSAs' }, ...Array.from({ length: 14 }, (_, i) => ({ label: `S-${100 + i} Fixture issue with a long title that runs on past the menu's width`, hint: 'in progress' }))]

const opener = (items: MenuItem[]) => (el: HTMLElement) => { const b = el.querySelector('button')!; const r = b.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, items, b) }
const trigger = <button className="icon-btn" aria-label="More"><Icon name="ellipsis" /></button>

export const stories: Story[] = [{
  name: 'Context menu',
  group: 'Primitives',
  what: 'The one context menu: rows of actions with an icon, a shortcut hint, sections, separators, radio or checkbox ticks, disabled and danger rows. On a phone the same menu is a sheet at the bottom. Arrow keys, Home, End, and Escape move through it.',
  when: "A right-click or long-press on an agent row, a pane, or a tab; a row's ⋯ button; the composer's recipient picker; the spawn menu.",
  code: ['web/src/ui/menu.tsx#showMenu', 'web/src/ui/menu.tsx#MenuItem', 'web/src/ui/menu.tsx#MenuLayer', 'web/src/ui/menu.tsx#hideMenu'],
  rules: [
    'A popover can open upward from its trigger (`showPopover`\'s `above`), capped to the room above it, as the prompt input\'s recipient menu does; it never runs off the viewport.',
    'Rows are `--size-row-menu` (28 px) on `--menu-bg` with `--radius-md` and `--shadow-float`, at `--z-popover` (' + ds('Modals and menus') + ').',
    'It enters at `--duration-base` with `--ease-out` and exits at 0 ms: a fading menu blocks what the user already chose to act on (' + ds('Never animated') + ').',
    'On a phone a row is at least `--size-hit-touch` (44 px), and the tap on the scrim that closes the sheet presses nothing under it.',
    'Danger rows take `--menu-danger-fg`; a disabled row takes `--menu-item-disabled-fg` and no hover wash.',
  ],
  states: [
    { name: 'Agent actions', height: 560, render: () => <OnMount run={opener(AGENT_MENU)}>{trigger}</OnMount> },
    { name: 'Each harness, by agent', height: 320, render: () => <OnMount run={opener(AGENTS)}>{trigger}</OnMount> },
    { name: 'Long', height: 640, render: () => <OnMount run={opener(LONG)}>{trigger}</OnMount> },
  ],
}, {
  name: 'Notice bar',
  group: 'Primitives',
  what: "The one transient notice: a single bar at the top centre for a result that has no place of its own on screen, such as a menu action's. A newer notice replaces it; notices never stack.",
  when: "After an action whose result has no source on screen: a copied branch, a menu action's failure, a new permission request. It stays 3.5 s, or 7 s for an error.",
  code: ['web/src/ui/menu.tsx#toast', 'web/src/ui/menu.tsx#MenuLayer'],
  rules: [
    'The persona rules ban toasts; this is the one exception they allow, and only for what has no source on screen (' + ds('Persona rules') + ').',
    'It is `--surface-raised` with a `--border-default` hairline, `--radius-sm`, and `--shadow-float`; an error takes `--status-error-fg` ink only.',
    'An error is announced as an alert, any other notice as status.',
  ],
  states: [
    { name: 'Status', height: 96, render: () => <OnMount run={() => holdTimers(() => toast('Copied stam/fixture-branch.'))} /> },
    { name: 'Error', height: 96, render: () => <OnMount run={() => holdTimers(() => toast("Couldn't pause fixture-dev: the daemon refused it.", true))} /> },
    { name: 'Long', height: 120, render: () => <OnMount run={() => holdTimers(() => toast('fixture-ops asks for permission. It\'s at the top of your mail, under the thread about the fixture branch at example.com.'))} /> },
  ],
}]
