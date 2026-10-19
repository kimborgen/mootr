// What a Needs-you row opens: its ITSA, its mail thread, or its agent. The Work page only
// shows what waits (S-363); the human acts on it where it opens.
import { selectAgent, selectThread } from '../actions'
import { openItsa } from '../itsa/itsa'
import type { NeedsRow } from './needs'

export function openNeeds(n: NeedsRow) {
  if (n.itsaId) return openItsa(n.itsaId)
  if (n.threadId) return selectThread(n.threadId)
  if (n.agent) return selectAgent(n.agent.id)
}
