// The developer slot cap (S-2008): at most `settings.developerCap` developer-type agents run on
// a machine at once. Ten managers each checked "load < 5" at spawn and all passed, so about 11
// developers ran together (load 12.7, S-1972). A developer is an agent whose workspace is a worktree and
// whose type is no reviewer type (reviewers have one too and are never capped). Only active agents hold a slot: paused,
// shut down and archived agents don't.
import type { AgentType } from './agent-types.ts';

export interface Slotted {
  name: string;
  type: string | null;
  workspace?: string | null;
  lifecycle: string;
  machine?: string;
}

// A spawn is a developer when its workspace is a worktree and its type is no reviewer, typed or not.
export const isDeveloperSpawn = (type: AgentType | undefined, worktree: boolean): boolean => worktree && !type?.review;

const hasWorktree = (a: Slotted): boolean => {
  try {
    return Boolean(a.workspace && JSON.parse(a.workspace).worktree);
  } catch {
    return false;
  }
};

// Names with a developer spawn in flight: the agent row, with its type, exists only after the workspace
// is made (seconds), so concurrent spawns would all read the same count. Counted with the holders.
const reserved = new Set<string>();
export const reserveSlot = (name: string): void => void reserved.add(name);
export const releaseSlot = (name: string): void => void reserved.delete(name);

// The active developer-type agents on `machine`, which are the slot holders.
export function developerHolders(agents: Slotted[], types: Record<string, AgentType>, machine: string): string[] {
  return agents.filter((a) => a.lifecycle === 'active' && hasWorktree(a) && !(a.type && types[a.type]?.review) && (a.machine ?? machine) === machine).map((a) => a.name);
}

// The refusal for a spawn of `type`, or null when it may start: other types and a cap of 0 are never limited.
export function developerCapRefusal(agents: Slotted[], types: Record<string, AgentType>, type: AgentType | undefined, worktree: boolean, cap: number, machine: string): string | null {
  if (!isDeveloperSpawn(type, worktree) || cap <= 0) return null;
  const held = developerHolders(agents, types, machine);
  const holders = [...held, ...[...reserved].filter((n) => !held.includes(n)).map((n) => `${n} (starting)`)];
  if (holders.length < cap) return null;
  return `developer slots full on ${machine} (${holders.length} of ${cap} in use, developerCap in settings to change); holders: ${holders.join(', ')}. Archive holders whose work is done, or retry when one finishes: wait_for a holder, or wake_me and spawn again.`;
}
