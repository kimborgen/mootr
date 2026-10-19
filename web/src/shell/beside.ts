// Which terminals stay detached (S-166). `all` is every leaf of the main world, `shown` the
// leaves on screen (on a phone, only the focused one). The active views on screen show; an
// agent's terminal hides when its conversation is on screen and the terminal isn't itself
// on screen. A terminal the human puts beside its conversation, on screen, stays attached.
import type { Leaf } from './layout'

export function beside(all: Leaf[], shown: Leaf[]): { show: string[]; hide: string[] } {
  const onScreen = new Set(shown.flatMap((l) => (l.active ? [l.active] : [])))
  const talking = new Set([...onScreen].flatMap((k) => (k.startsWith('view:') ? [k.slice(5)] : [])))
  const hide = all.flatMap((l) => l.tabs.filter((k) => k.startsWith('agent:') && talking.has(k.slice(6)) && !onScreen.has(k)))
  return { show: [...onScreen], hide }
}
