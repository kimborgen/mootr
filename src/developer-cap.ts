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
  activity?: string;
  idle_since?: string | null;
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

// A developer that went idle or started waiting holds its slot only this long (S-2120). Five minutes covers a
// short pause between turns, so a developer that is about to work again keeps its place; a developer
// waiting on a PR review or a reviewer, which uses no CPU, releases it.
export const IDLE_HOLD_MS = 5 * 60_000;
const holdsSlot = (a: Slotted, now: number): boolean => {
  if (a.activity !== 'idle' && a.activity !== 'waiting') return true;
  const since = a.idle_since ? Date.parse(a.idle_since) : NaN;
  return Number.isNaN(since) || now - since < IDLE_HOLD_MS;
};

// The active developer-type agents on `machine` that hold a slot now: working ones, and idle or waiting ones
// that went idle less than IDLE_HOLD_MS ago.
export function developerHolders(agents: Slotted[], types: Record<string, AgentType>, machine: string, now = Date.now()): string[] {
  return agents.filter((a) => a.lifecycle === 'active' && hasWorktree(a) && !(a.type && types[a.type]?.review) && (a.machine ?? machine) === machine && holdsSlot(a, now)).map((a) => a.name);
}

// Everything holding a slot on `machine`: the holders, then the spawns in flight.
export function slotHolders(agents: Slotted[], types: Record<string, AgentType>, machine: string, now = Date.now()): string[] {
  const held = developerHolders(agents, types, machine, now);
  return [...held, ...[...reserved].filter((n) => !held.includes(n)).map((n) => `${n} (starting)`)];
}

// The refusal for a spawn of `type`, or null when it may start: other types and a cap of 0 are never limited.
export function developerCapRefusal(agents: Slotted[], types: Record<string, AgentType>, type: AgentType | undefined, worktree: boolean, cap: number, machine: string, now = Date.now()): string | null {
  if (!isDeveloperSpawn(type, worktree) || cap <= 0) return null;
  const holders = slotHolders(agents, types, machine, now);
  if (holders.length < cap) return null;
  return `developer slots full on ${machine} (${holders.length} of ${cap} in use, developerCap in settings to change); holders: ${holders.join(', ')}. Archive holders whose work is done, or retry when one finishes: wait_for a holder, or wake_me and spawn again.`;
}

// The queue for a developer spawn at the cap (S-2053). A waiter holds the spawn's body and starts by
// itself when a slot frees. Urgent waiters go ahead of normal ones, first come first served within
// each class. The daemon saves it to a file after every change and restores it at start, so a
// restart or deploy during a wait loses no request (restoreQueue).
export const URGENT_REASONS = ['red-main', 'deploy-hold', 'approved-pr'] as const;
export type UrgentReason = (typeof URGENT_REASONS)[number];

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

// Whether a queued spawn named `name` can be cancelled (S-2134): it is waiting, or it was granted a slot and is
// launching (its name is in `launching`, so its agent may be starting), or no such spawn is queued.
export type CancelState = 'queued' | 'launching' | 'unknown';
export function cancelState(name: string, waiting: readonly Waiter[], launching: readonly string[]): CancelState {
  if (launching.includes(name)) return 'launching';
  return waiting.some((w) => w.name === name) ? 'queued' : 'unknown';
}

// Who may cancel a queued spawn (S-2134): its caller (`by`, the agent id), the caller's ancestors (`byAncestors`),
// and the boss (the chief of staff, the assistant, or the human), who may cancel any. A spawn with no known caller
// is the boss's alone.
export function mayCancelWaiter(by: string | undefined, me: string | undefined, boss: boolean, byAncestors: ReadonlySet<string>): boolean {
  if (boss) return true;
  if (by === undefined || me === undefined) return false;
  return me === by || byAncestors.has(me);
}

// The caller a spawn is keyed by for the duplicate check (S-2134): an agent's own id, which it can't forge, else the
// `by` the request names (the human's or a peer's spawn).
export const spawnerKey = (agent: string | undefined, by: unknown): string | undefined => agent ?? (by ? String(by) : undefined);

// The waiter a spawn named `name` by `by` on another machine duplicates (S-2134): same name, same caller.
export const findDuplicate = (waiting: readonly Waiter[], name: string, by: string): Waiter | undefined => waiting.find((w) => w.name === name && w.by === by);

// The machine's load and free memory, read for the guard in grantSlots.
export interface HostReading {
  load1: number;
  freeBytes: number;
}
// A queued slot is granted only while the machine has room (S-2120): the 1-minute load under 5 and more than
// 3 GB of memory free. The cap alone let developers start on a loaded machine (S-1972).
export const SLOT_MAX_LOAD = 5;
export const SLOT_MIN_FREE_BYTES = 3 * 1024 ** 3;
export const hostHasRoom = (h: HostReading): boolean => h.load1 < SLOT_MAX_LOAD && h.freeBytes > SLOT_MIN_FREE_BYTES;

// The machine sampler's latest sample: its tick time, the 1-minute load and the RAM in use of `ramTotal`.
export interface HostSample {
  ts: number;
  load: number[];
  ramTotal: number;
  ramUsed: number;
}
// The host's load and free memory from the sampler, when its last sample is fresh (`maxAgeMs`) and valid. A failed
// /proc read leaves the old sample in place, so an old one is never trusted: the OS readings (`osReading`) answer
// instead, as they do with no sample or a malformed one (S-2120 review).
export function hostReadingFrom(s: HostSample | null, now: number, maxAgeMs: number, osReading: () => HostReading): HostReading {
  if (s && now - s.ts >= 0 && now - s.ts <= maxAgeMs && s.ramTotal > 0) {
    const load1 = s.load?.[0] ?? NaN;
    const freeBytes = s.ramTotal - s.ramUsed;
    if (Number.isFinite(load1) && load1 >= 0 && Number.isFinite(freeBytes) && freeBytes >= 0) return { load1, freeBytes };
  }
  return osReading();
}

// Why a developer spawn is queued on a host without room, such as "queued: load 6.2" (S-2120), or null when it has room.
export function roomRefusal(h: HostReading): string | null {
  if (hostHasRoom(h)) return null;
  const why = [h.load1 < SLOT_MAX_LOAD ? null : `load ${h.load1.toFixed(1)}`, h.freeBytes > SLOT_MIN_FREE_BYTES ? null : `${(h.freeBytes / 1024 ** 3).toFixed(1)} GB free`];
  return `queued: ${why.filter(Boolean).join(', ')}`;
}

// One step with no await in it: drops the waiters whose caller is gone (`alive` says no), then, when the
// host has room, takes the slots that are free for the head of the queue. A waiter is never dropped for
// waiting long: a live caller's spawn waits until a slot frees. Each granted waiter's slot is reserved
// here, in the same step as the count, so no spawn that arrives later can take it; the caller releases
// that reservation when the agent row exists or the spawn failed.
export function grantSlots(agents: Slotted[], types: Record<string, AgentType>, cap: number, machine: string, alive: (w: Waiter) => boolean, host: HostReading, now = Date.now()): { granted: Waiter[]; dropped: Waiter[] } {
  const dropped = queue.filter((w) => !alive(w));
  for (const w of dropped) dropWaiter(w.name);
  const granted: Waiter[] = [];
  if (!hostHasRoom(host)) return { granted, dropped };
  let free = cap <= 0 ? Infinity : cap - slotHolders(agents, types, machine, now).length;
  while (queue.length && free > 0) {
    const w = queue.shift()!;
    reserveSlot(w.name);
    granted.push(w);
    free--;
  }
  return { granted, dropped };
}
