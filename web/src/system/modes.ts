// The system view's modes (S-460): each one a layout of the same cards, wires, flights and panel,
// in its own module behind one interface, which the header's switch picks between. A mode with no
// layout yet shows in the switch disabled. On the phone the Tree draws full cards (S-1067), and
// Cards and Stars stand tall, as its pane does (S-606). The mode comes from a link's
// `#view=system&mode=…`, else the viewer's last choice on this kind of screen, kept in this
// browser's storage, which may be missing or refuse: every read and write is guarded.
import { columnLayout, type Laid, treeLayout, type TreeIn } from './layout'
import { orbitLayout } from './orbits'
import { starsLayout, TALL as STARS_TALL } from './stars'

// The px values the layouts need, read from the tokens (SystemView's readPx), so CSS and layout agree.
// The orb and star-label sizes are the Stars mode's (S-539).
export interface Px {
  card: number; cardH: number; gapX: number; gapY: number; orbitGap: number; indent: number; rowGap: number; pad: number; sheetH: number; landIn: number; slowMs: number
  // One row of a card's nested issue (the agent card's ISSUE row, S-1438 PR 4).
  issueRow: number
  orbMin: number; orbMax: number; orbHuman: number; starLabelW: number; starLabelH: number; starLabelGap: number; starGap: number
  // What the zoom writes on the cards (zoom.ts).
  chipMax: number; chipClear: number; stackOver: number; stackOut: number
}

export type Mode = 'tree' | 'cards' | 'stars'
export interface ModeLayout {
  id: Mode
  label: string
  // The switch's tooltip.
  title: string
  // The cards' places and wires; absent while the mode is still to come. `tall`: for a phone's pane.
  layout?: (nodes: TreeIn[], px: Px, folded: ReadonlySet<string>, tall?: boolean) => Laid
}

export const MODES: readonly ModeLayout[] = [
  { id: 'tree', label: 'Tree', title: 'The org tree', layout: (nodes, px, folded, tall) => {
    const laid = treeLayout(nodes, { w: px.card, h: px.cardH, gapX: px.gapX, gapY: px.gapY, indent: px.indent, rowGap: px.rowGap }, folded)
    // On the phone the cards are full at any zoom, so their stacks sit out past the corner, as in Cards.
    return tall ? { ...laid, stacksOut: true } : laid
  } },
  { id: 'cards', label: 'Cards', title: 'Cards on orbits round the chief of staff', layout: (nodes, px, folded, tall) => tall
    ? columnLayout(nodes, { w: px.card, h: px.cardH, indent: px.indent, rowGap: px.rowGap }, folded)
    : orbitLayout(nodes, { w: px.card, h: px.cardH, gapX: px.gapX, gapY: px.orbitGap }, folded) },
  { id: 'stars', label: 'Stars', title: 'Agents as stars round the chief of staff, sized by spend', layout: (nodes, px, folded, tall) => starsLayout(nodes, { rMin: px.orbMin, rMax: px.orbMax, rHuman: px.orbHuman, labelW: px.starLabelW, labelH: px.starLabelH, labelGap: px.starLabelGap, gap: px.starGap, pad: px.pad, stretch: tall ? STARS_TALL : undefined }, folded) },
]
export const modeOf = (id: Mode): ModeLayout => MODES.find((m) => m.id === id)!

// A mode name that has a layout, or null.
export const asMode = (v: string | null | undefined): Mode | null => (MODES.find((m) => m.id === v && m.layout)?.id ?? null)
// The mode to start in: the link's, else the stored one, else Tree.
export const pickMode = (linked: string | null | undefined, stored: string | null | undefined): Mode => asMode(linked) ?? asMode(stored) ?? 'tree'

// The phone keeps its own choice: a layout that suits a wide desk may not suit a phone.
export const MODE_KEY = 'stam/system-mode'
export const PHONE_MODE_KEY = 'stam/system-mode-phone'
const keyOf = (phone: boolean) => (phone ? PHONE_MODE_KEY : MODE_KEY)
export function storedMode(phone = false): string | null {
  try { return localStorage.getItem(keyOf(phone)) } catch { return null }
}
export function saveMode(m: Mode, phone = false) {
  try { localStorage.setItem(keyOf(phone), m) } catch { /* storage refused: the mode lasts this visit */ }
}
