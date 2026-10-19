// After a deploy changes stam's MCP tools, running agents pick them up without a restart
// (S-178). Each agent's `stam mcp` loads the new release's tools itself and sends
// tools/list_changed (mcp.ts, followDeploys), which Claude Code honours. Harnesses that stam
// can reconnect without a restart (Codex, OpenCode) also reload their MCP servers at their
// next idle, in case they don't. Every running agent gets one notice naming the new, removed and changed tools.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MACHINE, STAM_HOME } from './config.ts';
import * as db from './db.ts';
import { queueNotice } from './mail.ts';
import { reconnectMcpWhenIdle } from './lifecycle.ts';
import { tools } from './mcp.ts';

// The tool list the last daemon start saw: name -> its description and schema.
const FILE = join(STAM_HOME, 'mcp-tools.json');

type Catalog = Record<string, string>;

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

// Claude Code has no reconnect that keeps the process: reconnect_mcp restarts the session and resumes its conversation
// (lifecycle.restart), which is too heavy to do to every Claude agent at idle on each deploy. The stdio server's
// tools/list_changed (mcp.ts) can leave a running session with the old schema of a tool that changed, so the notice
// names the changed tools and, for a Claude Code agent only, tells it to call reconnect_mcp itself, at a stopping point, if a parameter is missing.
// Codex and OpenCode agents reload at idle (reconnectMcpWhenIdle), so for them the notice lists the changes alone.
export function noticeText(d: { added: string[]; removed: string[]; changed?: string[] }, harness?: string): string | undefined {
  const changed = d.changed ?? [];
  const parts = [d.added.length && `new: ${d.added.join(', ')}`, d.removed.length && `removed: ${d.removed.join(', ')}`, changed.length && `changed: ${changed.join(', ')}`].filter(Boolean);
  if (!parts.length) return undefined;
  const hint = changed.length && harness === 'claude' ? ` If a changed tool lacks a parameter its description names, your session may hold its old schema: call reconnect_mcp when you reach a stopping point (it restarts you and resumes your conversation).` : '';
  return `[stam] stam's MCP tools changed in a deploy; ${parts.join('; ')}.${hint}`;
}

// At daemon start: compares this release's tools with the last start's, and tells this
// machine's running agents. The first start (no file) only records the list.
export async function announceToolChanges(): Promise<void> {
  const now = catalog();
  const before: Catalog | undefined = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : undefined;
  writeFileSync(FILE, JSON.stringify(now, null, 2));
  if (!before) return;
  const d = diff(before, now);
  if (!d.added.length && !d.removed.length && !d.changed.length) return;
  const running = db.listAgents().filter((a) => a.machine === MACHINE && (a.lifecycle === 'active' || a.lifecycle === 'paused'));
  for (const a of running) {
    db.addEvent(a.id, 'mcp-tools:changed', d);
    const text = noticeText(d, a.harness);
    if (text) queueNotice(a.id, text);
  }
  // Each agent is read again there, so one that went idle or busy meanwhile is handled as it is now.
  await reconnectMcpWhenIdle(running.map((a) => a.id));
}
