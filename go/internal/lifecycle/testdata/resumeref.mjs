#!/usr/bin/env node
// S-2848 B5e2: src/cost-switch.ts resumeSwitches, as a daemon start runs it, over a fixture of agents and their
// cost:switch histories. Argv: the fixture as JSON (SQL), the settings, the registry. Prints {resumed, failed}: the
// agents whose switch it re-armed, and every resume-failed step it wrote at once (a check that refused). The re-armed
// switches go on in the background; this exits before they do anything that matters here.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const home = tempHome('stam-resume-ref-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `resume-ref-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];
const [sqlJSON, settingsJSON, registryJSON] = process.argv.slice(2);
writeFileSync(join(home, 'settings.json'), settingsJSON);
writeFileSync(join(home, 'registry.json'), registryJSON);

const db = await import(new URL('src/db.ts', root));
const costSwitch = await import(new URL('src/cost-switch.ts', root));
const costNotices = await import(new URL('src/cost-notices.ts', root));
costNotices.notices(0);
const d = db.open();
for (const t of ['agents', 'agent_parents', 'events', 'blockers', 'cost_notices']) d.exec(`DELETE FROM ${t}`);
for (const q of JSON.parse(sqlJSON)) d.exec(q);
const resumed = costSwitch.resumeSwitches();
const failed = d
  .prepare("SELECT agent_id, data FROM events WHERE type = 'cost:switch' AND json_extract(data, '$.step') = 'resume-failed' ORDER BY id")
  .all()
  .map((e) => `${e.agent_id}|${e.data}`);
process.stdout.write(`${JSON.stringify({ resumed, failed })}\n`, () => process.exit(0));
