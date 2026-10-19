// One agent as a star (S-539): the Stars mode's card. An orb sized by spend (stars.ts), drawn as
// the agent's mark, the harness hue inside a state ring, as the sidebar draws it; under it the
// name, then the ITSA it owns and its cost. Unread mail stacks on the orb's top-right corner, as
// on a card. It moves as a card does (SystemCard, S-463): Motion places it by one transform, so a
// layout change glides it, a spawn grows out of its parent and an archive shrinks back into it, a
// status change stamps the ITSA's mark, and its cost rolls with a "+$" rising.
import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { animate, motion, useIsPresent } from 'motion/react'
import { costShort, stateLabel } from '../format'
import { Glyph, PlainGlyph } from '../Glyph'
import { StatusGlyph, statusLabel } from '../itsa/itsa'
import { Rise, Roll, useTiming } from './Roll'
import { cardTransform, spring, SPRINGS, tween } from './springs'
import { type CardModel, type CardPlace, type Exit, exitOf, GROW_FROM, ownCost, Stack } from './SystemCard'

// `dims`: the largest orb's radius, and how far a stack overhangs the orb's corner (system.css).
export interface StarDims { orbMax: number; stackOver: number }
interface Props { m: CardModel; sig: string; place: CardPlace; selected: boolean; enter: CardPlace | null; jump: boolean; dims: StarDims }

const STAMP_FROM = 'scale(1.15) rotate(-6deg)'
const STAMP_TO = 'scale(1) rotate(0deg)'

// Where the stack sits down from the orb's square, for an orb of radius r: on its corner, but never
// above the orb's slot, which stars.ts sizes for the largest orb (system.css, .sv-star .sv-stack).
const stackTop = (r: number, d: StarDims) => Math.max(-d.stackOver, r - d.orbMax)

function Star({ m, place, selected, enter, jump, dims }: Props) {
  const a = m.agent
  const human = !a
  const { slow, ease } = useTiming()
  const leaving = !useIsPresent()
  const at = (p: CardPlace, k = 1) => ({ transform: cardTransform(p.x, p.y, k), opacity: k === 1 ? 1 : 0 })
  const name = a?.name ?? 'You'
  const label = human ? 'You: asks and results arrive here' : `${name}, ${stateLabel(a)}${m.it ? `, ${m.it.key} ${m.it.title}` : ''}`
  const mode = a?.cost?.mode ?? 'api'
  const own = a ? ownCost(a) : null
  // Kept from render to render: a new format rewrites the roll's text (Roll).
  const fmtCost = useMemo(() => (v: number) => costShort(v, mode), [mode])
  // A status change on the same ITSA stamps its mark once, as on a card.
  const [st, setSt] = useState({ id: m.it?.id ?? null, status: m.it?.status ?? null, n: 0 })
  if ((m.it?.id ?? null) !== st.id || (m.it?.status ?? null) !== st.status) {
    setSt({ id: m.it?.id ?? null, status: m.it?.status ?? null, n: m.it && m.it.id === st.id ? st.n + 1 : st.n })
  }
  // Spend resizes the orb (S-462): its square takes the new size at once and Motion moves its
  // corner on the grow spring, while the orb scales from its old size on the same spring, from
  // that corner, so its middle stays put; the label, stack and fold ride the orb's edge as drawn.
  // By transform alone (scale and translate), so no layout runs per frame.
  // A resize that interrupts another starts from the size drawn then (`drawn`), not the old target.
  const el = useRef<HTMLDivElement>(null)
  const was = useRef(place.w)
  const drawn = useRef(place.w)
  const resized = was.current !== place.w && !enter && !jump
  useLayoutEffect(() => {
    const o = drawn.current, n = place.w
    was.current = n
    const root = el.current
    if (o === n || !root || enter || jump || !slow) { drawn.current = n; return }
    const part = (c: string) => root.querySelector<HTMLElement>(':scope > ' + c)
    const orb = part('.sv-orb'), sl = part('.sv-sl'), stack = part('.sv-stack'), fold = part('.sv-fold')
    if (orb) orb.style.transformOrigin = '0 0'
    const frame = (v: number) => {
      const V = n * (1 + (o / n - 1) * (1 - v)), d = V - n
      drawn.current = V
      if (orb) orb.style.scale = String(V / n)
      if (sl) sl.style.translate = `${d / 2}px ${d}px`
      if (stack) stack.style.translate = `${d}px ${stackTop(V / 2, dims) - stackTop(n / 2, dims)}px`
      if (fold) fold.style.translate = `${d}px ${d}px`
    }
    frame(0)
    const a = animate(0, 1, { ...spring(SPRINGS.grow, slow), onUpdate: frame })
    // The label's scale is the zoom's (zoom.ts): only the orb's is this animation's.
    return () => { a.stop(); if (orb) orb.style.scale = ''; for (const x of [sl, stack, fold]) if (x) x.style.translate = '' }
  }, [place.w]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <motion.div ref={el} className={'sv-star' + (human ? ' human' : '') + (m.hit ? ' hit ' + m.hit : '') + (selected ? ' sel' : '') + (enter ? ' enter' : '') + (leaving ? ' leave' : '')}
      data-card={leaving ? undefined : m.id} data-tid={m.id} role="group" aria-label={label} aria-hidden={leaving || undefined}
      style={{ '--r': `${place.w / 2}px` } as CSSProperties}
      initial={enter ? at(enter, GROW_FROM) : false}
      animate={{ ...at(place), transition: jump ? { duration: 0 } : { ...spring(enter || resized ? SPRINGS.grow : SPRINGS.move, slow), opacity: tween(slow, ease) } }}
      variants={{ out: (c: Exit | undefined) => exitOf(c, m.id, place, slow, ease, at) }}
      exit="out">
      {/* The orb is the star's one control: it opens the panel, as the whole star does on a click. */}
      <button type="button" className="sv-orb" data-open tabIndex={leaving ? -1 : 0} aria-pressed={selected} aria-label={`${name}: details`}>{a ? <Glyph agent={a} /> : <PlainGlyph name="user" />}</button>
      <div className="sv-sl" aria-hidden="true">
        <span className="sv-nm" title={name}>{m.short}</span>
        <span className="l2">
          {m.it ? <>
            <motion.span key={st.n} className="sv-stamp" initial={st.n ? { transform: STAMP_FROM } : false} animate={{ transform: STAMP_TO }} transition={spring(SPRINGS.stamp, slow)}>
              <StatusGlyph status={m.it.status} title={statusLabel(m.it.status)} /></motion.span>
            <span className="sv-key">{m.it.key}</span>
          </> : null}
          {a?.cost ? <span className="sv-cost">{own == null ? costShort(null, mode) : <Roll value={own} fmt={fmtCost} />}{mode === 'api' || mode === 'subscription' ? <Rise value={own} fmt={fmtCost} /> : null}</span> : null}
          {human && m.badges[0]?.kind === 'word' ? <span className="warn">{m.badges[0].word}</span> : null}
        </span>
      </div>
      <Stack id={m.id} n={m.unread} name={name} />
      {m.folded ? <button type="button" className="sv-fold shut" data-fold={m.id} aria-expanded={false} aria-label={`Show ${name}'s ${m.folded.n} ${m.folded.n === 1 ? 'agent' : 'agents'}`}>
        +{m.folded.n}{m.folded.states.map((s) => <span key={s.state} className="dot" style={{ background: `var(--st-${s.state})` }} title={`${s.n} ${s.state}`} />)}
      </button> : null}
    </motion.div>
  )
}

export const StarCard = memo(Star, (p, n) => p.sig === n.sig && p.selected === n.selected && p.place.x === n.place.x && p.place.y === n.place.y && p.place.w === n.place.w && p.enter === n.enter && p.jump === n.jump && p.dims === n.dims)
