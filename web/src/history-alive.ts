// Whether the thing a history entry names still exists (S-1456). An agent or an issue is gone when
// the lists have loaded and don't hold it; a thread can't be told from the lists (agent-to-agent
// threads aren't in them), and the pages always exist. Before a list has loaded, nothing is dead.
import { getData } from './store'

export function worldAlive(world: string): boolean {
  const d = getData()
  if (world.startsWith('w:itsa:')) return !d.loaded.itsas || d.itsas.some((i) => i.id === world.slice(7))
  if (world.includes(':')) return true
  return !d.loaded.agents || d.agents.some((a) => a.id === world)
}
