// The human's layout, one for the whole daemon: worlds, panes, and tabs (layout-ops.ts),
// kept in STAM_HOME/layout.json and written atomically (temp file, then rename). Every web
// client follows it live through the stream. Agents' MCP calls go through `applyOps`.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { STAM_HOME } from './config.ts';
import { apply, deadImageTabOps, emptyLayout, validLayout, type Layout, type LayoutOp } from './layout-ops.ts';
import { PageLiveness } from './page-liveness.ts';

// One op as a short phrase, for the agent's event log: `open agent:X in main`.
export function describeOp(op: LayoutOp): string {
  switch (op.op) {
    case 'open': return `open ${op.key} in ${op.world}`;
    case 'close': return `close ${op.key} in ${op.world}`;
    case 'swap': return `show ${op.with} in place of ${op.key} in ${op.world}`;
    case 'move': return `move ${op.key} to pane ${op.to} in ${op.world}`;
    case 'split': return `split pane ${op.pane} ${op.side} in ${op.world}`;
    case 'closePane': return `close pane ${op.pane} in ${op.world}`;
    case 'activate': return `show ${op.key} in pane ${op.pane} of ${op.world}`;
    case 'focus': return `focus pane ${op.pane} in ${op.world}`;
    case 'tabBar': return `${op.on ? 'show' : 'hide'} the tab bar of pane ${op.pane} in ${op.world}`;
    case 'resize': return `resize split ${op.split} in ${op.world}`;
    case 'setRoot': return `rearrange ${op.world}`;
    case 'dropWorld': return `drop the world ${op.world}`;
    case 'current': return `show ${op.world ?? 'home'}`;
  }
}

const FILE = join(STAM_HOME, 'layout.json');
const newId = () => 'p' + randomUUID().slice(0, 8);

// A stale `base` (the caller's version isn't the current one): the caller gets the current layout.
export class LayoutConflict extends Error {
  layout: Layout;
  constructor(layout: Layout, message: string) {
    super(message);
    this.layout = layout;
  }
}

function load(): Layout {
  if (!existsSync(FILE)) return emptyLayout();
  try {
    const l = JSON.parse(readFileSync(FILE, 'utf8'));
    if (validLayout(l)) return l;
    console.error(`layout: ${FILE} isn't a layout; starting empty`);
  } catch (e) {
    console.error(`layout: couldn't read ${FILE} (${e instanceof Error ? e.message : e}); starting empty`);
  }
  return emptyLayout();
}

let layout: Layout = load();
const listeners = new Set<(l: Layout) => void>();

function save(next: Layout) {
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, FILE);
}
function commit(next: Layout) {
  save(next);
  layout = next;
  for (const fn of listeners) fn(layout);
}

export function getLayout(): Layout {
  return layout;
}

// The ids of the batches applied lately, oldest first: a client that lost the reply to a
// batch sends it again, and it must not apply twice (its new panes would repeat their ids).
const BATCHES_KEPT = 512;
const applied = new Set<string>();

// Applies every op in order, all or none. The batch is one version step. `base`, when given,
// must be the current version, else LayoutConflict. Invalid ops throw an Error and change
// nothing. `batch`, a client's id for the call, makes a repeat of it return the layout as it
// is, applying nothing.
export function applyOps(ops: LayoutOp[], base?: number, batch?: string): Layout {
  if (batch !== undefined && applied.has(batch)) return layout;
  if (base !== undefined && base !== layout.version) throw new LayoutConflict(layout, `layout is at version ${layout.version}, not the base ${base}`);
  if (!ops.length) return layout;
  let next = layout;
  for (const op of ops) next = apply(next, op, newId);
  next = { ...next, version: layout.version + 1 };
  // A change that leaves a malformed tree would be refused at the next start, so it's refused now.
  if (!validLayout(next)) throw new Error('that change would leave an invalid layout (a pane tree with no children, or sizes that aren\'t positive numbers); nothing changed');
  commit(next);
  if (batch !== undefined) {
    applied.add(batch);
    if (applied.size > BATCHES_KEPT) applied.delete(applied.values().next().value!);
  }
  return layout;
}

// Replaces the whole layout (the web's one-time move from its browser storage). Only while
// the stored layout is empty; otherwise LayoutConflict.
export function replaceLayout(next: unknown): Layout {
  if (layout.current !== null || Object.keys(layout.agentWorlds).length || Object.keys(layout.worlds).length)
    throw new LayoutConflict(layout, 'the layout isn\'t empty; PUT replaces only an empty layout');
  if (!validLayout(next)) throw new Error('not a layout: needs version, current, agentWorlds, and worlds, with well-formed panes');
  const committed: Layout = { ...next, version: layout.version + 1 };
  commit(committed);
  return layout;
}

// Calls fn with the layout now and after every change. Returns the unsubscribe.
export function subscribe(fn: (l: Layout) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// The web pages that hold a layout stream are live (page-liveness.ts); the sweep closes the image tabs of
// the ones that aren't, and those are the only tabs it touches.
const SWEEP = 15_000;
const PAGE_ID = /^[a-z0-9]{1,12}$/;
const pages = new PageLiveness(Date.now());
export function dropDeadImageTabs(now = Date.now()): void {
  pages.prune(now);
  const ops = deadImageTabOps(layout, (page) => pages.live(page, now));
  if (ops.length) applyOps(ops);
}
setInterval(() => {
  try { dropDeadImageTabs(); } catch (e) { console.error(`layout: couldn't close the image tabs of dead pages (${e instanceof Error ? e.message : e})`); }
}, SWEEP).unref();

// Server-sent events: the layout on connect and after every change. A client that falls
// more than STREAM_CAP bytes behind (it stopped reading) is dropped; it reconnects and gets
// the whole layout again.
const STREAM_CAP = 1 << 20;
const streams = new Set<ServerResponse>();
export function streamLayout(res: ServerResponse, page?: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  streams.add(res);
  const id = page !== undefined && PAGE_ID.test(page) ? page : null;
  if (id !== null) pages.open(id);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  // Cleanup first: nothing below awaits, and a closed socket must leave the set at once.
  res.on('close', () => {
    clearInterval(ping);
    streams.delete(res);
    if (id !== null) pages.close(id, Date.now());
  });
  res.write(`event: layout\ndata: ${JSON.stringify(layout)}\n\n`);
}
subscribe((l) => {
  const data = `event: layout\ndata: ${JSON.stringify(l)}\n\n`;
  for (const res of streams) {
    if (res.writableLength > STREAM_CAP) res.destroy();
    else res.write(data);
  }
});
