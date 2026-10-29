#!/usr/bin/env node
// S-3807: src/readings.ts (and the other usage modules) run over a copy of a Go test's database, with the same settings
// and registry prices. Argv: the database copy, settings.json's text, registry.json's text, now (ms), what to run
// (readings, codex, summary, tree, typical, issues, series or scope), optionally a peer's GET /api/usage/readings answer
// (served by a stub peer1 and read once before the run), then the mode's own arguments, named at each mode below.
// Prints the result as JSON.stringify does.
import { join } from 'node:path';
import { copyFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const home = tempHome('stam-usage-ref-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `usage-ref-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test-machine';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];
const [dbPath, settingsJSON, registryJSON, nowArg, what, peerJSON] = process.argv.slice(2);
copyFileSync(dbPath, join(home, 'stam.db'));
const settings = JSON.parse(settingsJSON);
let stub;
if (peerJSON) {
  stub = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/api/usage/readings' ? peerJSON : '{}');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  settings.peers = [{ name: 'peer1', url: `http://127.0.0.1:${stub.address().port}`, token: 'stub-token' }];
}
writeFileSync(join(home, 'settings.json'), JSON.stringify(settings));
writeFileSync(join(home, 'registry.json'), registryJSON);
const now = Number(nowArg);
// summary reads the clock itself: Date.now() and new Date() are now.
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    if (a.length) super(...a);
    else super(now);
  }
  static now() {
    return now;
  }
};
if (peerJSON) {
  const peerReadings = await import(new URL('src/peer-readings.ts', root));
  await peerReadings.refresh(now);
}

let out;
if (what === 'readings') {
  const { accountReadings } = await import(new URL('src/readings.ts', root));
  out = accountReadings(now);
} else if (what === 'codex') {
  const db = await import(new URL('src/db.ts', root));
  const { codexView } = await import(new URL('src/codex-usage-view.ts', root));
  const row = db.open().prepare("SELECT data, updated_at FROM subscriptions WHERE name = 'codex'").get();
  out = codexView(row ? JSON.parse(row.data) : null, row?.updated_at ?? null, now);
} else if (what === 'summary') {
  // Argv 7 to 9: days, the agent types to keep as a JSON array (null keeps every agent), and optionally the tree's
  // agent id.
  const [days, keepJSON, tree] = process.argv.slice(8);
  const usage = await import(new URL('src/usage.ts', root));
  const keep = JSON.parse(keepJSON);
  out = usage.summary(Number(days), tree || undefined, keep ? new Set(keep) : null);
} else if (what === 'tree') {
  // Argv 7 and 8: days, and the tree's agent id. The summary's tree view without what treeView adds to treeSummary.
  const [days, tree] = process.argv.slice(8);
  const usage = await import(new URL('src/usage.ts', root));
  const { allocations, typical_issue, ...rest } = usage.summary(Number(days), tree, null).tree;
  out = rest;
} else if (what === 'typical') {
  // Argv 7: the configs to ask issue-costs.ts typicalIssue for, as a JSON array.
  const { typicalIssue } = await import(new URL('src/issue-costs.ts', root));
  out = JSON.parse(process.argv[8]).map((c) => typicalIssue(c, { now }));
} else if (what === 'issues') {
  // Argv 7: days (null reads every sample). GET /api/usage/issues: issueCosts with the daemon's display context.
  const { issueCosts } = await import(new URL('src/issue-costs.ts', root));
  const { displayCtx } = await import(new URL('src/agent-costs.ts', root));
  const days = JSON.parse(process.argv[8]);
  out = issueCosts({ days: days == null ? undefined : days, display: displayCtx(now), now });
} else if (what === 'series') {
  // Argv 7 to 10: days, the group, the visible agents and the readable ITSA keys as JSON arrays (null for neither).
  const drill = await import(new URL('src/usage-drill.ts', root));
  const [days, group, visibleJSON, itsasJSON] = process.argv.slice(8);
  const visible = JSON.parse(visibleJSON);
  const itsas = JSON.parse(itsasJSON);
  out = drill.spendSeries({ days: Number(days), group, now, visible: visible ? new Set(visible) : undefined, mayItsa: itsas ? (k) => itsas.includes(k) : undefined });
} else if (what === 'scope') {
  // Argv 7: the scope options as JSON (days, kind, ref, harness, since, bucket, and visible and itsas as arrays).
  const drill = await import(new URL('src/usage-drill.ts', root));
  const o = JSON.parse(process.argv[8]);
  out = drill.drillScope({ ...o, now, visible: o.visible ? new Set(o.visible) : undefined, mayItsa: o.itsas ? (k) => o.itsas.includes(k) : undefined });
} else {
  throw new Error(`usageref.mjs: unknown ${what}`);
}
console.log(JSON.stringify(out));
process.exit(0);
