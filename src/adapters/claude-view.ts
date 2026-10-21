// Claude Code's part of stam's own agent view (src/agent-view.ts): read-mostly. The agent's
// transcript (JSONL, `transcript_path`) is the history and the live feed: each row is a block
// when Claude Code writes it, so text shows when it ends, not as it's written
// (`can_stream: false`). Activity comes from the hooks (db); permissions are the recorded
// requests, shown read-only, because stam has no blocking permission hook (S-81).
// Prompts go into the terminal's input box and Esc interrupts, as the human's do.
import { statSync } from 'node:fs';
import type { Agent } from '../db.ts';
import * as db from '../db.ts';
import { ViewError } from '../agent-view.ts';
import type { LiveSink, ViewMessage, ViewPermission, ViewSource, ViewStore } from '../agent-view.ts';
import { claude } from './claude.ts';
import { restoreTranscript } from '../transcript-gz.ts';
import { Transcript } from './claude-transcript.ts';

export { Transcript };

// Activities that mean a turn is going: a permission or question dialog holds the turn open.
const RUNNING = new Set(['starting', 'working', 'blocked']);
// The follow poll: a transcript row lands within this of being written.
export const POLL_MS = 300;
// How many transcripts stay parsed at once. A transcript nobody follows is dropped first;
// one dropped is parsed again from its start on its next read.
const MAX_FILES = 8;

// The parsed transcripts, most recently used last. Eviction skips the ones followed.
const cache = new Map<string, Transcript>();
function transcriptFor(file: string): Transcript {
  let t = cache.get(file);
  if (t) {
    cache.delete(file);
  } else {
    t = new Transcript(file);
  }
  cache.set(file, t);
  for (const [f, old] of cache) {
    if (cache.size <= MAX_FILES) break;
    if (!old.watchers && f !== file) cache.delete(f);
  }
  return t;
}
// How many transcripts are parsed now, for tests.
export const cachedTranscripts = (): number => cache.size;

// How many bytes of `file` its parsed copy hasn't read yet; undefined when it isn't parsed. The
// turn index reads a cached transcript in place only while this is small (S-1580), and leaves
// the cache's order alone.
export function unreadBytes(file: string): number | undefined {
  const t = cache.get(file);
  if (!t) return undefined;
  try {
    return Math.max(0, statSync(file).size - t.position);
  } catch {
    return undefined;
  }
}

// What the view shows for an agent's permissions: its recorded requests, and a dialog the
// hooks saw (activity 'blocked') that no request records. Read-only either way.
function permissionsOf(a: Agent): ViewPermission[] {
  const recorded = db
    .listPermissionRequests('pending')
    .filter((p) => p.agent_id === a.id)
    .map((p) => ({ id: p.id, action: p.action, resources: p.details ? [p.details] : [] }));
  if (a.activity === 'blocked' && !recorded.length) {
    const question = a.activity_detail === 'question';
    return [{ id: `blocked:${a.id}`, action: question ? 'question' : 'permission', resources: a.activity_detail ? [a.activity_detail] : [] }];
  }
  return recorded;
}

// Puts one transcript message into the store, its parts by the slots the store keeps
// (`text:N`, `reasoning:N`, `tool:ID`), keeping what the store has beyond the transcript's.
function apply(store: ViewStore, m: ViewMessage): void {
  const cur = store.message(m.id, () => ({ id: m.id, role: m.role, at: m.at, parts: [] }));
  if (m.marks) cur.marks = [...m.marks];
  const nth: Record<string, number> = {};
  for (const p of m.parts) {
    const key = p.type === 'tool' ? `tool:${p.id}` : `${p.type}:${(nth[p.type] = (nth[p.type] ?? -1) + 1)}`;
    const part = store.part<any>(m.id, key, () => ({ ...p }));
    Object.assign(part, p);
  }
}

// Prompts to one agent go in one at a time: each waits for the last to be typed and taken,
// and then finds the box empty and the agent idle or not.
const queued = new Map<string, Promise<void>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const claudeView: ViewSource = {
  capabilities: { can_stream: false, can_send: true, can_interrupt: true, can_approve: false },

  unavailable: (a) => (a.transcript_path ? null : `${a.name} has no Claude Code transcript yet`),

  // The newest `limit` messages before `before`, oldest first; the transcript's path is the
  // agent's current one. The parsed transcript is shared and read incrementally, and the
  // page is copied out, so a caller can't change what the cache holds.
  async page(a, { limit, before }) {
    const cur = db.getAgent(a.id) ?? a;
    // A gzipped transcript (an archived agent's) is restored first; a failure is the view's error.
    await restoreTranscript(a.id, cur.transcript_path ?? a.transcript_path);
    const t = transcriptFor(cur.transcript_path ?? a.transcript_path!);
    t.read();
    const all = t.messages;
    const end = before ? Math.max(0, all.findIndex((m) => m.id === before)) : all.length;
    const start = Math.max(0, end - limit);
    return { messages: structuredClone(all.slice(start, end)), older: start > 0 ? all[start].id : null };
  },

  async status(a) {
    const cur = db.getAgent(a.id) ?? a;
    return { running: RUNNING.has(cur.activity), permissions: permissionsOf(cur) };
  },

  // Polls the transcript for appended rows and the agent's activity and permissions. A
  // replaced transcript (new path, or a shorter file) empties the window and is re-read.
  follow(a, live: LiveSink) {
    const { store } = live;
    let file: string | null = null;
    let t: Transcript | null = null;
    let seen = 0;
    // Takes the file as followed: what's already in it is the page's, so it's read and not emitted.
    const attach = (f: string | null) => {
      file = f;
      t = f ? transcriptFor(f) : null;
      if (!t) return;
      t.watchers++;
      t.read();
      t.take();
      seen = t.resets;
    };
    const detach = () => {
      if (t) t.watchers--;
      t = null;
    };
    const resetWindow = () => {
      store.messages = [];
      store.hasOlder = false;
      store.replaced = true;
      live.changed();
      live.resync();
    };
    attach(a.transcript_path ?? null);
    const tick = () => {
      const cur = db.getAgent(a.id) ?? a;
      let changed = false;
      if ((cur.transcript_path ?? null) !== file) {
        detach();
        attach(cur.transcript_path ?? null);
        return resetWindow();
      }
      if (t) {
        t.read();
        if (t.resets !== seen) {
          seen = t.resets;
          t.take();
          return resetWindow();
        }
        // The newest harness message: a mail in the window can be newer than a turn's start.
        const newest = store.messages.findLast((x) => x.kind !== 'mail')?.at ?? -Infinity;
        for (const id of t.take()) {
          const m = t.byId.get(id);
          if (!m) continue;
          // A message the window doesn't hold is older than its oldest page, or new: only new ones join.
          if (store.messages.some((x) => x.id === id) || m.at >= newest) {
            apply(store, m);
            changed = true;
          }
        }
      }
      const running = RUNNING.has(cur.activity ?? '');
      if (running !== store.running) store.setRunning(running);
      const perms = permissionsOf(cur);
      if (JSON.stringify(perms) !== JSON.stringify(store.permissions)) {
        store.permissions = perms;
        store.statusDirty = true;
        changed = true;
      }
      if (changed || store.statusDirty || store.dirty.size) live.changed();
    };
    tick();
    const timer = setInterval(() => {
      try {
        tick();
      } catch {
        // A transcript that vanished mid-read: the next tick finds it again or not.
      }
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      detach();
    };
  },

  // Typed into the terminal's input box, the way the human's own prompt goes in. Prompts to
  // one agent queue: each is typed only after the last one is taken (the agent is no longer
  // idle), so two at once can't land in one box. Refused while the box holds a draft or a
  // dialog is up: the view doesn't guess.
  async prompt(a, text) {
    const prev = queued.get(a.id) ?? Promise.resolve();
    const typed = prev.then(async () => {
      const fresh = db.getAgent(a.id) ?? a;
      if (!(await claude.typeHumanInput!(fresh, text))) throw new ViewError(409, `${a.name}'s input box isn't free for a prompt now; use the terminal`);
    });
    queued.set(
      a.id,
      typed.then(
        async () => {
          // Enter sends the prompt; the agent turns busy when its UserPromptSubmit hook lands.
          for (let i = 0; i < 100 && (db.getAgent(a.id)?.activity ?? 'idle') === 'idle'; i++) await sleep(50);
        },
        () => undefined,
      ),
    );
    return typed;
  },

  // 'steer' has no separate path in Claude Code: it types the same prompt.
  interrupt: (a) => claude.interrupt!(db.getAgent(a.id) ?? a),
};
