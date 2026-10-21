// After a deploy changes stam's MCP tools, running agents pick them up without a restart
// (S-178). Each agent's `stam mcp` loads the new release's tools itself and sends
// tools/list_changed (mcp.ts, followDeploys), which Claude Code honours. Harnesses that stam
// can reconnect without a restart (Codex, OpenCode) also reload their MCP servers at their
// next idle, in case they don't. Every running agent gets one notice naming the new, removed and
// changed tools, once per deploy: a record on disk keeps a repeat daemon start or a rollback from
// sending it again (S-1744).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MACHINE, RELEASE, STAM_HOME } from './config.ts';
import * as db from './db.ts';
import { queueNotice } from './mail.ts';
import { reconnectMcpWhenIdle } from './lifecycle.ts';
import { tools } from './mcp.ts';

// The tool list the last daemon start saw: name -> its description and schema.
const FILE = join(STAM_HOME, 'mcp-tools.json');
// Which agents heard which release's tool-change notice (S-1744), keyed by release id. Written to
// disk so it survives the restart of the daemon that sends the notice: one deploy, one notice per
// agent, however many times that daemon starts or the tools flip back and forth. `told` agents
// have seen it; `pending` agents are standing agents whose notice is queued but not yet delivered,
// so the next start queues it again rather than losing it.
const NOTICES_FILE = join(STAM_HOME, 'mcp-notices.json');
// How many releases' records to keep, enough to cover a rollback that flips a few times.
const KEEP_RELEASES = 5;

type Catalog = Record<string, string>;
type Change = { added: string[]; removed: string[]; changed: string[] };
type ReleaseRecord = { d: Change; told: string[]; pending: string[] };
type Told = { releases: Record<string, ReleaseRecord> };

export function catalog(list: { name: string; description: string; inputSchema: unknown }[] = tools): Catalog {
  return Object.fromEntries(list.map((t) => [t.name, JSON.stringify([t.description, t.inputSchema])]));
}

export function diff(before: Catalog, after: Catalog): { added: string[]; removed: string[]; changed: string[] } {
  const names = (c: Catalog) => Object.keys(c).sort();
  return {
    added: names(after).filter((n) => !(n in before)),
    removed: names(before).filter((n) => !(n in after)),
    changed: names(after).filter((n) => n in before && before[n] !== after[n]),
  };
}

const changed = (d: Change): boolean => !!(d.added.length || d.removed.length || d.changed.length);

// The deploy this daemon started for: the release folder's name, or 'checkout' from a dev run.
const releaseKey = (): string => RELEASE ?? 'checkout';

// The record, by release. A missing or unreadable file means none.
export function readTold(): Told {
  try {
    const parsed = JSON.parse(readFileSync(NOTICES_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.releases && typeof parsed.releases === 'object' ? (parsed as Told) : { releases: {} };
  } catch {
    return { releases: {} };
  }
}

// Writes the record, keeping only the newest KEEP_RELEASES releases (insertion order is age).
// A unique temp file renamed into place, so a crash part-way through leaves the old record, not
// partial JSON that readTold would read as empty.
export function saveTold(told: Told): void {
  const keys = Object.keys(told.releases);
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_RELEASES))) delete told.releases[k];
  const tmp = `${NOTICES_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(told, null, 2));
  renameSync(tmp, NOTICES_FILE);
}

// A standing agent's passive notice reached it: it is told now, and no later start queues it again.
function markDelivered(release: string, agentId: string): void {
  try {
    const told = readTold();
    const rec = told.releases[release];
    if (!rec || !rec.pending.includes(agentId)) return;
    rec.pending = rec.pending.filter((id) => id !== agentId);
    if (!rec.told.includes(agentId)) rec.told.push(agentId);
    saveTold(told);
  } catch {
    // A record that can't be written just means the notice may be queued again at the next start.
  }
}

// Claude Code has no reconnect that keeps the process: reconnect_mcp restarts the session and resumes its conversation
// (lifecycle.restart), which is too heavy to do to every Claude agent at idle on each deploy. The stdio server's
// tools/list_changed (mcp.ts) can leave a running session with the old schema of a tool that changed, so the notice
// names the changed tools and, for a Claude Code agent only, says the listed schema of a changed tool may be stale: the agent can still
// pass a parameter that the tool's description or the notice names, because the call reaches stam. reconnect_mcp doesn't refresh the schema.
// Codex and OpenCode agents reload at idle (reconnectMcpWhenIdle), so for them the notice lists the changes alone.
export function noticeText(d: { added: string[]; removed: string[]; changed?: string[] }, harness?: string): string | undefined {
  const changedTools = d.changed ?? [];
  const parts = [d.added.length && `new: ${d.added.join(', ')}`, d.removed.length && `removed: ${d.removed.join(', ')}`, changedTools.length && `changed: ${changedTools.join(', ')}`].filter(Boolean);
  if (!parts.length) return undefined;
  const hint = changedTools.length && harness === 'claude' ? ` A changed tool's listed schema may be stale: if it lacks a parameter that the tool's description or this notice names, pass that parameter anyway, since the call reaches stam.` : '';
  return `[stam] stam's MCP tools changed in a deploy; ${parts.join('; ')}.${hint}`;
}

// At daemon start: compares this release's tools with the last start's, and tells this
// machine's running agents. The first start (no file) only records the list. Each agent hears
// about a release at most once (S-1744), recorded on disk so a repeat start doesn't repeat it;
// a standing agent's passive notice is queued again until it is delivered.
export async function announceToolChanges(): Promise<void> {
  const now = catalog();
  const before: Catalog | undefined = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : undefined;
  writeFileSync(FILE, JSON.stringify(now, null, 2));
  const release = releaseKey();
  const record = readTold();
  const rec: ReleaseRecord = record.releases[release] ?? { d: { added: [], removed: [], changed: [] }, told: [], pending: [] };
  if (!before) return; // the very first start only records the list
  const d = diff(before, now);
  if (changed(d)) rec.d = d;
  if (!changed(rec.d)) return;
  // A resting agent (S-1982) loads the new tools when it next starts; a notice would only wake it for nothing.
  const running = db.listAgents().filter((a) => a.machine === MACHINE && (a.lifecycle === 'active' || a.lifecycle === 'paused') && !db.restOwned(a));
  const told = new Set(rec.told);
  const pending = new Set(rec.pending);
  const alreadyPending = new Set(rec.pending);
  let queued = false;
  for (const a of running) {
    if (told.has(a.id)) continue;
    const text = noticeText(rec.d, a.harness);
    if (!text) continue;
    // A standing agent is woken only for real work (S-1744): its notice is passive, so it never
    // starts a turn, and it is marked told only once delivery confirms it was seen.
    if (a.standing === 1) {
      queueNotice(a.id, text, { passive: true, onTaken: () => markDelivered(release, a.id) });
      pending.add(a.id);
    } else {
      queueNotice(a.id, text);
      told.add(a.id);
    }
    queued = true;
    // A standing agent whose notice is queued again at a later start is the same notice, not a new one.
    if (!alreadyPending.has(a.id)) db.addEvent(a.id, 'mcp-tools:changed', rec.d);
  }
  if (queued) {
    rec.told = [...told];
    rec.pending = [...pending];
    record.releases[release] = rec;
    saveTold(record);
  }
  // Each agent is read again there, so one that went idle or busy meanwhile is handled as it is now.
  if (changed(d)) await reconnectMcpWhenIdle(running.map((a) => a.id));
}