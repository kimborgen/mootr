// Which of an agent's two views shows (S-82): its terminal (`agent:ID`, always there) or
// stam's own view of its conversation (`view:ID`, only when its harness has one). The
// human picks per agent with the switch in its pane; selecting an agent opens it in its
// default: the agent's own (`default_view`, kept by the daemon) or else Settings'
// (`agentView.default`, the conversation unless Settings says terminal), and the terminal
// whenever the agent has no view.
import type { Agent } from '../types'

export type AgentViewChoice = 'terminal' | 'conversation'

export const keyFor = (id: string, v: AgentViewChoice) => (v === 'conversation' ? 'view:' : 'agent:') + id
// The agent and the view a tab key shows, for the two keys an agent's views have.
export function choiceOf(key: string | null | undefined): { id: string; view: AgentViewChoice } | null {
  if (key?.startsWith('agent:')) return { id: key.slice(6), view: 'terminal' }
  if (key?.startsWith('view:')) return { id: key.slice(5), view: 'conversation' }
  return null
}

export function defaultView(a: Pick<Agent, 'view' | 'default_view'> | undefined, global: AgentViewChoice | null | undefined): AgentViewChoice {
  if (!a?.view) return 'terminal'
  return a.default_view ?? global ?? 'conversation'
}

// Whether the pane showing `key` gets the switch: an agent's view, of an agent that has both.
export const switchable = (key: string | null | undefined, a: Pick<Agent, 'view'> | undefined) => !!choiceOf(key) && !!a?.view

// What selecting an agent changes in its world, given every tab the world has: show the
// default view in place of the other one. Nothing when the default already shows, when the
// world has neither (it gets its default when made), or when it shows both side by side
// (the human put them there).
export function swapForDefault(tabs: string[], id: string, want: AgentViewChoice): { key: string; with: string } | null {
  const wantKey = keyFor(id, want)
  const otherKey = keyFor(id, want === 'terminal' ? 'conversation' : 'terminal')
  if (tabs.includes(wantKey) || !tabs.includes(otherKey)) return null
  return { key: otherKey, with: wantKey }
}
