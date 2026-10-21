// Builds a home with agents and requirements switched on, copies its stam.db to stam.pre.db, then runs the ops of
// reqs-steps.json through src/requirements.ts the way src/daemon.ts routes them (reqRoute: a refusal is 403, an unknown
// requirement or link 404, any other throw 400), and the check engine of src/req-check.ts (op `check` is a manual text check,
// `tool` a peer's tool-call check; the decision model is the stub of test/decide-stub.mjs), and writes what each returned to expect.json, for go/internal/server's
// requirements test (S-2952, PR 2). The approval asks of src/req-approval.ts are not part of it. Never the live home.
//
//   node go/internal/server/testdata/reqsref.mjs DIR [SETTINGS.json-text [OPS.json]]
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: reqsref.mjs DIR');
  process.exit(2);
}
const home = resolve(dir);
if (existsSync(`${home}/stam.db`)) {
  console.error(`reqsref: ${home} already has a stam.db`);
  process.exit(2);
}
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'test-machine';
process.env.STAM_EMBEDDER = 'stub';
writeFileSync(`${home}/settings.json`, process.argv[3] ?? JSON.stringify({ requirements: { enabled: true }, itsa: { ownerNotices: 'off' } }));
const config = await import('../../../../src/config.ts');
if (config.LIVE_HOME) {
  console.error('reqsref: refusing the live home');
  process.exit(2);
}
const db = await import('../../../../src/db.ts');
const requirements = await import('../../../../src/requirements.ts');
const reqCheck = await import('../../../../src/req-check.ts');
const reqApproval = await import('../../../../src/req-approval.ts');
const itsa = await import('../../../../src/itsa.ts');
const mail = await import('../../../../src/mail.ts');
// As src/daemon.ts names the actor: the human when no one is named.
const person = async (by) => (by ? ((await itsa.person(by)) ?? by) : mail.HUMAN);

const base = { machine: 'test-machine', harness: 'claude', model: 'claude-opus-5-5', effort: null, cwd: home, session_id: null };
db.createAgent({ ...base, id: 'aboss', name: 'boss', role: 'manager', parent_id: null });
db.createAgent({ ...base, id: 'achild', name: 'child', role: 'developer', parent_id: 'aboss' });
const d = db.open();
d.exec('PRAGMA wal_checkpoint(TRUNCATE)');
copyFileSync(`${home}/stam.db`, `${home}/stam.pre.db`);

const ops = JSON.parse(readFileSync(new URL(process.argv[4] ?? './reqs-steps.json', import.meta.url), 'utf8'));
const ids = [];
const sub = (v) => (typeof v === 'string' ? v.replace(/^#(\d+)$/, (_, n) => ids[Number(n)] ?? v) : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
const results = [];
for (const [i, op] of ops.entries()) {
  await new Promise((r) => setTimeout(r, 3));
  let id = '';
  try {
    const ref = sub(op.ref ?? '');
    const input = sub(op.input ?? {});
    const by = op.by ?? null;
    let out;
    if (op.op === 'sql') {
      d.exec(op.sql.replace(/'#(\d+)'/g, (_, n) => `'${ids[Number(n)]}'`));
      out = {};
    } else if (op.op === 'list') {
      const q = op.query ?? {};
      out = requirements.list({ parent: q.parent, status: q.status, text: q.text, latest: q.verdicts === 'latest' });
    } else if (op.op === 'create') {
      out = await requirements.create({ ...input, by });
      id = out.id;
      // As src/daemon.ts routes it: a draft an agent wrote opens an approval ask.
      if (by && by !== mail.HUMAN && out.status === 'draft') {
        const a = await reqApproval.ask(out, await person(by));
        out = { ...out, approval: 'key' in a ? { itsa: a.key, to: a.to } : { error: a.error } };
      }
    } else if (op.op === 'batch') {
      const made = await requirements.createBatch(input.requirements, by);
      const actor = (await person(by)) ?? mail.HUMAN;
      out = { requirements: made };
      if (actor !== mail.HUMAN) {
        const a = await reqApproval.askBatch(made, actor);
        out.approval = 'key' in a ? { itsa: a.key, to: a.to } : { error: a.error };
      }
    } else if (op.op === 'get') out = requirements.get(ref, { verdict: op.verdict });
    else if (op.op === 'set') {
      out = await requirements.set(ref, input, by);
      if (Object.keys(out.changes).length && out.requirement.status === 'draft') await reqApproval.refresh(out.requirement.key, await person(by));
      if (out.changes.status?.to === 'in_force') await reqApproval.approvedElsewhere(out.requirement.key, (await person(by)) ?? mail.HUMAN);
    }
    else if (op.op === 'link') out = requirements.addLink(ref, input);
    else if (op.op === 'unlink') {
      requirements.removeLink(ref, Number(op.link));
      out = { removed: Number(op.link) };
    } else if (op.op === 'preview') out = await reqCheck.preview(ref, input.n);
    else if (op.op === 'check') out = await reqCheck.manual(input);
    else if (op.op === 'tool') out = await reqCheck.toolFromPeer(input);
    else if (op.op === 'waive') out = await requirements.waive({ ...input, by: by ?? 'human' });
    else throw new Error(`bad op ${op.op}`);
    results.push({ status: 200, result: out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let status = /^no requirement |^no link /.test(msg) ? 404 : 400;
    if (e instanceof requirements.ForbiddenError) status = 403;
    results.push({ status, error: msg });
  }
  ids.push(id);
}
const tables = {};
for (const name of ['requirements', 'req_links', 'req_verdicts', 'req_waivers', 'req_counter']) tables[name] = d.prepare(`SELECT * FROM ${name} ORDER BY ${name === 'requirements' ? 'created_at, key' : '1'}`).all();
// The asks (src/req-approval.ts), without ids and times: the ITSAs, their comments in order, and the stamps.
tables.itsas = d.prepare("SELECT key, kind, title, summary, body, status, owner FROM itsas ORDER BY rowid").all();
tables.ask_mail = d.prepare("SELECT m.from_id, m.body FROM mail m JOIN itsas i ON i.thread_id = m.thread_id WHERE m.body NOT LIKE '%needs you:%' AND m.body NOT LIKE 'Meant for your user%' ORDER BY m.rowid").all();
const has = (n) => d.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(n);
if (has("req_approvals")) tables.req_approvals = d.prepare("SELECT req_key, rev, via FROM req_approvals ORDER BY req_key").all();
if (has("req_batch_asks")) tables.req_batch_asks = d.prepare("SELECT req_key, rev, via FROM req_batch_asks ORDER BY req_key").all();
tables.events = d.prepare("SELECT agent_id, type, data FROM events WHERE type LIKE 'req:%' ORDER BY id").all();
writeFileSync(`${home}/expect.json`, JSON.stringify({ results, tables, ids }));
process.exit(0);
