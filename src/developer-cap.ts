// The developer slot cap (S-2008): at most `settings.developerCap` developer-type agents run on
// a machine at once. Ten managers each checked "load < 5" at spawn and all passed, so about 11
// developers ran together (load 12.7, S-1972). A developer is an agent whose workspace is a worktree and
// whose type is no reviewer type (reviewers have one too and are never capped). Only active agents hold a slot: paused,
// shut down and archived agents don't.
import { renameSync, writeFileSync, readFileSync } from 'node:fs';
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

// Everything holding a slot on `machine`: the holders, then the spawns in flight.
export function slotHolders(agents: Slotted[], types: Record<string, AgentType>, machine: string): string[] {
  const held = developerHolders(agents, types, machine);
  return [...held, ...[...reserved].filter((n) => !held.includes(n)).map((n) => `${n} (starting)`)];
}

// The refusal for a spawn of `type`, or null when it may start: other types and a cap of 0 are never limited.
export function developerCapRefusal(agents: Slotted[], types: Record<string, AgentType>, type: AgentType | undefined, worktree: boolean, cap: number, machine: string): string | null {
  if (!isDeveloperSpawn(type, worktree) || cap <= 0) return null;
  const holders = slotHolders(agents, types, machine);
  if (holders.length < cap) return null;
  return `developer slots full on ${machine} (${holders.length} of ${cap} in use, developerCap in settings to change); holders: ${holders.join(', ')}. Archive holders whose work is done, or retry when one finishes: wait_for a holder, or wake_me and spawn again.`;
}

// The queue for a developer spawn at the cap (S-2053). A waiter holds the spawn's body and starts by
// itself when a slot frees. Urgent waiters go ahead of normal ones, first come first served within
// each class. The daemon saves it to a file after every change and restores it at start, so a
// restart or deploy during a wait loses no request (restoreQueue).
export const URGENT_REASONS = ['red-main', 'deploy-hold', 'approved-pr'] as const;
export type UrgentReason = (typeof URGENT_REASONS)[number];
// A waiter nobody started for this long is dropped, so an abandoned wait can't hold the queue.
export const QUEUE_MAX_WAIT_MS = 2 * 3600_000;

export interface Waiter {
  name: string;
  body: unknown;
  by?: string;
  urgent?: UrgentReason;
  at: number;
}

const queue: Waiter[] = [];
export const queuedWaiters = (): readonly Waiter[] => queue;
export const queuePlace = (name: string): number => queue.findIndex((w) => w.name === name) + 1;

// Adds `w` after the last waiter of its class or a more urgent one; returns its place, counted from 1.
export function enqueueWaiter(w: Waiter): number {
  let at = queue.length;
  if (w.urgent) at = queue.findLastIndex((x) => x.urgent) + 1;
  queue.splice(at, 0, w);
  return at + 1;
}

// Puts waiters read back from the saved queue in front of any already there, keeping their order.
export function restoreQueue(ws: Waiter[]): void {
  const have = new Set(queue.map((w) => w.name));
  queue.unshift(...ws.filter((w) => !have.has(w.name)));
}

// Writes the whole snapshot to a sibling temp file and renames it over `file`, so a crash mid-write
// leaves the old complete file. Throws when it can't, so the caller doesn't accept what isn't saved.
export function saveQueueFile(file: string, ws: readonly Waiter[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ws));
  renameSync(tmp, file);
}

// The saved waiters, split: those whose agent row already exists (`exists`) were launched before the
// restart and are not queued again; the rest are waiting. A missing file is an empty queue; a corrupt
// one throws, so it is never taken for an empty queue.
export function loadQueueFile(file: string, exists: (name: string) => boolean): { waiting: Waiter[]; started: Waiter[] } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { waiting: [], started: [] };
    throw e;
  }
  const ws = JSON.parse(raw);
  if (!Array.isArray(ws)) throw new Error('saved slot queue is not a list');
  const ok = ws.filter((w: Waiter) => w && typeof w.name === 'string' && w.body && typeof w.at === 'number');
  return { waiting: ok.filter((w) => !exists(w.name)), started: ok.filter((w) => exists(w.name)) };
}

export const dropWaiter = (name: string): boolean => {
  const i = queue.findIndex((w) => w.name === name);
  if (i >= 0) queue.splice(i, 1);
  return i >= 0;
};

// One step with no await in it: drops the waiters that are dead (`alive` says no) or past the wait
// limit, then takes the slots that are free for the head of the queue. Each granted waiter's slot is
// reserved here, in the same step as the count, so no spawn that arrives later can take it; the
// caller releases that reservation when the agent row exists or the spawn failed.
export function grantSlots(agents: Slotted[], types: Record<string, AgentType>, cap: number, machine: string, alive: (w: Waiter) => boolean, now = Date.now()): { granted: Waiter[]; dropped: Waiter[] } {
  const dropped = queue.filter((w) => now - w.at > QUEUE_MAX_WAIT_MS || !alive(w));
  for (const w of dropped) dropWaiter(w.name);
  const granted: Waiter[] = [];
  let free = cap <= 0 ? Infinity : cap - slotHolders(agents, types, machine).length;
  while (queue.length && free > 0) {
    const w = queue.shift()!;
    reserveSlot(w.name);
    granted.push(w);
    free--;
  }
  return { granted, dropped };
}
