// The Activity tab at real scale (S-1011): S-1009's realistic fixture (test/activity-fixture.mjs,
// 700 agents over 7 days by default, several trees, every wait kind, Claude Code, Codex and OpenCode)
// seeded into a check daemon's home before the daemon starts, so its activity summary folds it at
// start-up like any other items. A test daemon only: it refuses a home without lib.sh's marker.
//   STAM_HOME=... node web/check/seed-activity.mjs [AGENTS]
// The fixture's agents are archived (out of the tree), their ids and names start with ax-, and their
// ITSAs are AX-N, so the daemon's own agents and S-N keys are untouched.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.STAM_HOME;
if (!home || !existsSync(join(home, '.stam-test-home'))) { console.error('seed-activity: STAM_HOME must be a test home (lib.sh daemon_home)'); process.exit(2); }
const agents = Number(process.argv[2] ?? 700);
const db = await import('../../src/db.ts');
const { seedScale } = await import('../../test/activity-fixture.mjs');
const t = performance.now();
const f = seedScale(db, { agents, days: 7, now: Date.now(), wipe: false, prefix: 'ax-', keyPrefix: 'AX', lifecycle: 'archived', windows: false, allTypes: true });
// The ITSA key counter seeds itself from the highest key number on first use; start it here, so the
// daemon's own ITSAs still begin at S-1.
db.open().prepare("INSERT OR IGNORE INTO itsa_counter (name, value) VALUES ('key', 0)").run();
console.error(`seed-activity: ${f.agents} agents, ${f.items} items, ${f.itsas} ITSAs in ${Math.round(performance.now() - t)} ms`);
