// Computes lessons from similar work with the TS daemon's own src/retro-lessons.ts and src/retro.ts, for
// go/internal/instructions' parity test (S-3776). DIR is a test home (never the live home) that the Go test filled:
// stam.db (with the retro items and their stub vectors) and settings.json; FAKEHOME is the user home. The stub
// embedder is on. Stdin is JSON:
//
//   {"agents": ["id", ...]}
//
// It prints, per agent, taskText, lessonsFor's keys and scores at the settings' k, renderLessons of them, and
// lessonsPrompt with the retro:lessons event it recorded (without its ms).
//
//   node go/internal/instructions/testdata/lessonsref.mjs DIR FAKEHOME < input.json
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';

const [dir, fakeHome] = process.argv.slice(2);
if (!dir || !fakeHome) {
  console.error('usage: lessonsref.mjs DIR FAKEHOME');
  process.exit(2);
}
process.env.STAM_HOME = resolve(dir);
process.env.HOME = resolve(fakeHome);
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_EMBEDDER = 'stub';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_RELEASE_ID']) delete process.env[k];
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('lessonsref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const { settings } = await import('../../../../src/settings.ts');
const { deps, taskText, lessonsPrompt } = await import('../../../../src/retro-lessons.ts');
const { lessonsFor, renderLessons } = await import('../../../../src/retro.ts');

const input = JSON.parse(readFileSync(0, 'utf8'));
const agents = {};
for (const id of input.agents) {
  const a = db.getAgent(id);
  const hits = await lessonsFor(deps, taskText(a), settings().retro.lessons.k);
  const text = await lessonsPrompt(a);
  const ev = db.open().prepare("SELECT data FROM events WHERE agent_id = ? AND type = 'retro:lessons' ORDER BY id DESC LIMIT 1").get(id);
  const event = ev ? JSON.parse(ev.data) : null;
  if (event) delete event.ms;
  agents[id] = { task: taskText(a), hits: hits.map((h) => ({ key: h.key, score: h.score })), rendered: renderLessons(hits), prompt: text, event };
}
writeSync(1, JSON.stringify({ agents }));
process.exit(0);
