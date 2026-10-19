// Shared settings across machines (S-390, S-380 change 2). The home serves the shared part of its
// settings.json, with its registry.json and instructions.md (S-387), under one rev, and tells its
// peers when that rev changes. A non-home daemon fetches them at boot, on the home's push, and on a
// poll, into its cache (settings.shared.json), keeping the last good copy while the home is down.
// Nothing here runs on a request's path or blocks boot.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAM_HOME } from './config.ts';
import { GLOBAL_INSTRUCTIONS } from './instructions.ts';
import { isSettingsHome, onSettingsChange, readSettingsText, readSharedCache, settings, sharedPart, writeSharedCache } from './settings.ts';
import { peers, peerByName, peerCall, peerNotify } from './peers.ts';
import { originOf } from './web-origins.ts';

const POLL_MS = Number(process.env.STAM_SETTINGS_SYNC_MS) || 60_000;
const FETCH_MS = 5000;
const PUSH_MS = 3000;

// ---- Home side ----

// The home's shared settings as peers get them: the raw shared part of its file, not normalised
// (the peer normalises it), with its user registry (registry.json, or {}) and its instructions for
// all agents (instructions.md, or ''), S-387, and the sha256 of all three as one rev. Null when the
// settings file isn't valid JSON, so a peer keeps its cache rather than take the defaults. A registry
// that isn't valid JSON goes as {}, as the home itself reads it. Kept until a file's text changes.
export interface SharedPayload {
  rev: string;
  settings: Record<string, any>;
  registry: Record<string, any>;
  instructions: string;
}
let served: { key: string; payload: SharedPayload | null } | null = null;
const readText = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
export function sharedPayload(): SharedPayload | null {
  const text = readSettingsText();
  const registryText = readText(join(STAM_HOME, 'registry.json'));
  const instructions = readText(GLOBAL_INSTRUCTIONS);
  const key = JSON.stringify([text, registryText, instructions]);
  if (served?.key === key) return served.payload;
  let payload = null;
  try {
    const shared = sharedPart(text ? JSON.parse(text) : {});
    let registry: any = {};
    try {
      registry = JSON.parse(registryText);
    } catch {}
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) registry = {};
    const json = JSON.stringify({ settings: shared, registry, instructions });
    payload = { rev: createHash('sha256').update(json).digest('hex'), settings: shared, registry, instructions };
  } catch {}
  served = { key, payload };
  return payload;
}

// After a write to settings.json on the home, each peer is told the new rev, fire-and-forget: a
// down peer catches up on its poll. Deferred off the write path, coalesced, and skipped when the
// shared part didn't change (a local key, or a cache write on a peer). The home also pushes once at
// boot, so a change made while a peer was out of reach, or by hand, doesn't wait for the poll.
// stam's own writes to registry.json and instructions.md (agent types, the config page) call
// sharedFilesChanged to push the same way; a hand edit to either reaches peers on their poll, which
// asks the home for its current rev, or on the home's next boot.
let pushedRev: string | null = null;
let pushQueued = false;
export const sharedFilesChanged = (): void => schedulePush();
function schedulePush(): void {
  if (pushQueued) return;
  pushQueued = true;
  setTimeout(() => {
    pushQueued = false;
    try {
      pushIfChanged();
    } catch (e) {
      console.error(`settings push: ${e instanceof Error ? e.message : e}`);
    }
  }, 0);
}
export function watchHomeChanges(): void {
  onSettingsChange(schedulePush);
  schedulePush();
}
function pushIfChanged(): void {
  if (!isSettingsHome()) return;
  const rev = sharedPayload()?.rev;
  if (!rev || rev === pushedRev) return;
  pushedRev = rev;
  for (const p of peers()) peerNotify(p, 'POST', '/api/config/settings/changed', { rev }, PUSH_MS);
}

// ---- Peer side ----

export interface SyncState {
  home: string;
  rev: string | null;
  fetchedAt: string | null;
  lastError: string | null;
  // The cache may be behind the home: no fetch has succeeded yet, or the last one failed.
  stale: boolean;
  // The home's web UI origin, where this daemon's UI sends shared writes (S-414); null when the home
  // has none a browser can reach (no `tailscale serve`), and on the home itself.
  homeWeb: string | null;
}
let rev: string | null = null;
let homeWeb: string | null = null;
let fetchedAt: string | null = null;
let lastError: string | null = null;

export function syncState(): SyncState {
  const home = settings().home;
  if (isSettingsHome()) return { home, rev: sharedPayload()?.rev ?? null, fetchedAt: null, lastError: null, stale: false, homeWeb: null };
  return { home, rev, fetchedAt, lastError, stale: lastError !== null || fetchedAt === null, homeWeb };
}

// One sync at a time: a call while one runs makes exactly one more run after it.
let running: Promise<void> | null = null;
let again = false;
export function syncShared(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await fetchOnce();
    } while (again);
  })().finally(() => (running = null));
  return running;
}

async function fetchOnce(): Promise<void> {
  if (isSettingsHome()) return;
  const home = settings().home;
  try {
    const peer = peerByName(home);
    if (!peer) throw new Error(`the settings home '${home}' is not a configured peer`);
    const r = await peerCall(peer, 'GET', `/api/config/settings/shared${rev ? `?rev=${encodeURIComponent(rev)}` : ''}`, undefined, FETCH_MS);
    if (r.status !== 200) throw new Error(`${home} answered ${r.status}: ${r.data?.error ?? ''}`);
    // Only a bare origin is taken, so the UI can't be sent to a path or another scheme.
    const web = typeof r.data?.web === 'string' && originOf(r.data.web) === r.data.web.toLowerCase().replace(/\/$/, '') ? originOf(r.data.web)! : null;
    if (!r.data?.unchanged) {
      const next = r.data?.settings;
      if (typeof r.data?.rev !== 'string' || !next || typeof next !== 'object' || Array.isArray(next)) throw new Error(`${home} sent no shared settings`);
      // A home from before S-387 sends no registry or instructions: the cache has none, and this
      // daemon reads its own files for them.
      const reg = r.data.registry;
      const cache: Record<string, unknown> = { rev: r.data.rev, settings: next };
      if (reg && typeof reg === 'object' && !Array.isArray(reg)) cache.registry = reg;
      if (typeof r.data.instructions === 'string') cache.instructions = r.data.instructions;
      if (web) cache.web = web;
      if (r.data.rev !== rev || web !== homeWeb) writeSharedCache(JSON.stringify(cache, null, 2) + '\n');
      rev = r.data.rev;
    }
    // A home that starts or stops serving its page with no settings change: the cache keeps the new
    // origin too, so a restart doesn't bring back the old one.
    if (r.data?.unchanged && web !== homeWeb) {
      const c = readSharedCache();
      if (c) {
        const next: Record<string, unknown> = { ...c };
        if (web) next.web = web;
        else delete next.web;
        writeSharedCache(JSON.stringify(next, null, 2) + '\n');
      }
    }
    homeWeb = web;
    fetchedAt = new Date().toISOString();
    if (lastError) console.log(`settings sync: ${home} reached again`);
    lastError = null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Logged once per outage, not per poll.
    if (!lastError) console.error(`settings sync: can't fetch the shared settings from ${home}, keeping the cached copy: ${msg}`);
    lastError = msg;
  }
}

// A push from the home: a sync, unless this daemon already has that rev.
export function homeChanged(pushed: unknown): void {
  if (typeof pushed === 'string' && pushed === rev && !lastError) return;
  void syncShared();
}

// Started once the daemon is up, never awaited: a sync now, then every POLL_MS.
export function startSettingsSync(): void {
  const c = readSharedCache();
  rev = typeof c?.rev === 'string' ? c.rev : null;
  homeWeb = c?.web && originOf(c.web) === c.web ? c.web : null;
  void syncShared();
  setInterval(() => void syncShared(), POLL_MS);
}
