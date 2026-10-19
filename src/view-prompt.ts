import type { Agent } from './db.ts';
import * as db from './db.ts';
import * as agentView from './agent-view.ts';
import * as lifecycle from './lifecycle.ts';

// A prompt typed in the web view. A resting agent has no harness to type into: the prompt wakes it and is
// what it is told on waking (S-2034), and the wake waits for its delivery, so a launch that fails reaches the person as an error. Any other hold on it (a pause, a cost blocker) keeps it down, a 409 naming it.
export async function prompt(a: Agent, text: string, delivery: 'queue' | 'steer'): Promise<void> {
  if (!lifecycle.isResting(a)) return agentView.prompt(a, text, delivery);
  if (!text.trim()) throw new agentView.ViewError(400, 'text is empty');
  let r: string;
  try {
    r = await lifecycle.wakeResting(a.id, 'a prompt from the web view', true, text);
  } catch (e) {
    throw new agentView.ViewError(409, `${a.name} is resting and could not be woken: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Woken another way while this waited (mail, a notice): it is up now, so the prompt goes in as for any live agent.
  if (r === 'not resting') return agentView.prompt(db.getAgent(a.id) ?? a, text, delivery);
  if (r !== 'active') throw new agentView.ViewError(409, `${a.name} is resting and ${r}`);
  db.addEvent(a.id, 'view-prompt', { delivery, chars: text.length, woke: true });
}
