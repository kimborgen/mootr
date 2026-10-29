#!/usr/bin/env node
// A stand-in for bin/stam in the pr_merge unit test (STAM_PR_MERGE_STAM, S-3802): it answers the failure routing's calls from the
// test's own STAM_HOME database with the production code, so the shapes are the CLI's: `show` prints publicAgent, `itsa show`
// itsa.get, `itsa set|post|new` write through itsa.ts as the --system sender. `resume` brings back a gone agent that has a
// session (lifecycle active, no harness started) and refuses as lifecycle.resume does. Each call's argv goes to
// STAM_PR_MERGE_STUB_DIR/stam-calls.jsonl; STAM_STUB_FAIL (a regex over the argv) fails a matching call as an unreachable daemon.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const args = process.argv.slice(2);
appendFileSync(join(process.env.STAM_PR_MERGE_STUB_DIR, 'stam-calls.jsonl'), `${JSON.stringify(args)}\n`);
const die = (m) => {
  process.stderr.write(`stam: ${m}\n`);
  process.exit(1);
};
if (process.env.STAM_STUB_FAIL && new RegExp(process.env.STAM_STUB_FAIL).test(args.join(' '))) die('fetch failed');
const db = await import('../src/db.ts');
const itsa = await import('../src/itsa.ts');
const { publicAgent } = await import('../src/agent-public.ts');
db.open();

const [cmd, ...rest] = args;
if (cmd === 'show') {
  const a = db.getAgent(rest[0]);
  if (!a) die(`no agent ${rest[0]}`);
  console.log(JSON.stringify(publicAgent(a), null, 2));
} else if (cmd === 'resume') {
  const a = db.getAgent(rest[0]);
  if (!a) die(`no agent ${rest[0]}`);
  if (a.lifecycle !== 'shut_down' && a.lifecycle !== 'archived') die(`${a.name} is ${a.lifecycle}`);
  if (!a.session_id) die(`${a.name} has no session to resume`);
  db.updateAgent(a.id, { lifecycle: 'active' });
  console.log(`${a.name}: resuming`);
} else if (cmd === 'itsa') {
  const [sub, ...more] = rest;
  const { values: v, positionals } = parseArgs({ args: more, allowPositionals: true, options: { status: { type: 'string' }, 'if-status': { type: 'string' }, system: { type: 'string' }, parent: { type: 'string' }, summary: { type: 'string' }, body: { type: 'string' } } });
  const by = itsa.systemActor(v.system ?? 'pr-merge');
  try {
    if (sub === 'show') console.log(JSON.stringify(itsa.get(positionals[0]), null, 2));
    else if (sub === 'set') console.log(JSON.stringify((await itsa.set(positionals[0], { status: v.status, ...(v['if-status'] !== undefined ? { ifStatus: v['if-status'] } : {}) }, by)).changes));
    else if (sub === 'post') await itsa.post(positionals[0], { body: positionals[1], by });
    else if (sub === 'new') {
      const x = await itsa.create({ title: positionals.join(' '), parent: v.parent, status: v.status, summary: v.summary, body: v.body, by });
      console.log(`${x.key}  ${x.title}`);
    } else die(`unknown itsa ${sub}`);
  } catch (e) {
    die(e.message);
  }
} else die(`unknown command ${cmd}`);
process.exit(0);
