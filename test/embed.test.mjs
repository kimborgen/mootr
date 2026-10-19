#!/usr/bin/env node
// Unit tests for the embedder and the embedding index (S-141): the stub is deterministic,
// normalised, and ranks a paraphrase with shared stems above an unrelated text; the cosine and
// nearest math; and the index's round trip through the db. No model runs (the stub provider;
// the local model is never installed in tests). Run with `node --test test/embed.test.mjs`.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from './tmphome.mjs';

// The db opens at STAM_HOME when first used, so point it at a throwaway folder first.
process.env.STAM_HOME = tempDir('stam-embed-unit-');
process.env.STAM_EMBEDDER = 'stub';
const { stubVector, embedText, normalise, currentModel, embed, installed, setInstallSteps, whenInstalled } = await import('../src/embed.ts');
const { cosine, nearest, enqueue, source, indexMail, backfill, hashOf, setQueueCap, DEFAULT_QUEUE_CAP } = await import('../src/vectors.ts');
const db = await import('../src/db.ts');

test('the stub is deterministic and normalised', () => {
  const a = stubVector('Users keep getting redirected back to sign-in');
  const b = stubVector('Users keep getting redirected back to sign-in');
  assert.equal(a.length, 256);
  assert.deepEqual([...a], [...b]);
  const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6, `norm ${norm}`);
  assert.equal(stubVector('').reduce((s, x) => s + x, 0), 0, 'empty text is the zero vector');
});

test('a paraphrase sharing stems ranks above an unrelated text', () => {
  const q = stubVector('keeps redirecting users');
  const near = stubVector('users are redirected back to the sign-in page');
  const far = stubVector('invoice reconciliation for september');
  assert.ok(cosine(q, near) > cosine(q, far), `${cosine(q, near)} vs ${cosine(q, far)}`);
  assert.ok(cosine(q, near) > 0.2);
});

test('cosine and normalise', () => {
  const x = normalise(Float32Array.from([3, 4]));
  assert.ok(Math.abs(x[0] - 0.6) < 1e-6 && Math.abs(x[1] - 0.8) < 1e-6);
  assert.equal(cosine(x, x), 1);
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0);
  assert.equal(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1])), 0, 'a zero vector matches nothing');
});

test('the embed text is prose with the component fences dropped', () => {
  const t = embedText('Login loop', '```decision\nWhich fix?\n```\nthe session cookie is dropped');
  assert.ok(t.includes('Which fix?') && t.includes('the session cookie is dropped'), t);
  assert.ok(!t.includes('```'), t);
});

test('the stub provider reports its model and embeds a batch in order', async () => {
  assert.equal(currentModel(), 'stub-256');
  const vecs = await embed(['one thing', 'another thing']);
  assert.equal(vecs.length, 2);
  assert.deepEqual([...vecs[1]], [...stubVector('another thing')]);
});

test('the index stores vectors and nearest returns them best first', async () => {
  const put = (ref, text) => db.putEmbedding({ source: 'unit', ref, model: 'stub-256', dim: 256, vec: new Uint8Array(stubVector(text).buffer), hash: ref });
  put('redirect', 'users keep getting redirected back to sign-in');
  put('invoice', 'invoice reconciliation for september');
  // The queue reads the text through the source's resolver and embeds it through the stub.
  const texts = { queued: 'redirect loop after logout, users redirected again' };
  source('unit', (ref) => texts[ref]);
  assert.equal(enqueue('unit', 'queued'), true);
  const q = stubVector('keeps redirecting users');
  for (let i = 0; i < 100 && !db.embeddingRow('unit', 'queued'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(db.embeddingRow('unit', 'queued'), 'the queued item was never indexed');
  const all = nearest('unit', q, undefined, Infinity);
  assert.deepEqual(all.map((n) => n.ref).slice(0, 2).sort(), ['queued', 'redirect'].sort());
  assert.equal(all.at(-1).ref, 'invoice');
  const only = nearest('unit', q, new Set(['invoice', 'redirect']), 1);
  assert.equal(only.length, 1);
  assert.equal(only[0].ref, 'redirect');
  db.deleteEmbedding('unit', 'queued');
});

test('the queue holds ids up to its cap, then refuses new ones', () => {
  setQueueCap(DEFAULT_QUEUE_CAP);
  source('capped', () => undefined);
  let accepted = 0;
  let last = '';
  for (let i = 0; i < DEFAULT_QUEUE_CAP + 500; i++) if (enqueue('capped', `r${i}`)) { accepted++; last = `r${i}`; }
  // A batch leaves the queue as soon as it starts, so the cap is reached a little above the default.
  assert.ok(accepted >= DEFAULT_QUEUE_CAP && accepted <= DEFAULT_QUEUE_CAP + 16, `accepted ${accepted}`);
  // The newest id is still queued (the queue works from the front): queuing it again is a no-op, not a refusal.
  assert.equal(enqueue('capped', last), true, 'an id queued already is not refused');
});

test('a partial install is not installed: the package alone has no marker', () => {
  // The install writes its marker last; a package folder without it (killed mid-install) doesn't count.
  const pkg = join(process.env.STAM_HOME, 'embedder', 'node_modules', '@huggingface', 'transformers');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{}');
  assert.equal(installed(), false);
});

test('mail dropped for a full queue is indexed without a restart', async () => {
  // A cap of one drops all but the first mail; the backfill runs when the queue empties and indexes them.
  const ids = ['ov1', 'ov2', 'ov3', 'ov4', 'ov5'];
  setQueueCap(1);
  for (const id of ids) db.createMail({ id, from_id: 'unit', from_name: 'unit', subject: `overflow ${id}`, body: `body ${id} redirects`, thread_id: id, reply_to: null }, [], []);
  for (const id of ids) indexMail(id);
  setQueueCap(DEFAULT_QUEUE_CAP);
  for (let i = 0; i < 300 && !ids.every((id) => db.embeddingRow('mail', id)); i++) await new Promise((r) => setTimeout(r, 20));
  for (const id of ids) assert.ok(db.embeddingRow('mail', id), `${id} was never indexed`);
});

test('an install marker for another version or model is not installed', () => {
  const dir = join(process.env.STAM_HOME, 'embedder');
  mkdirSync(join(dir, 'node_modules', '@huggingface', 'transformers'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@huggingface', 'transformers', 'package.json'), '{}');
  writeFileSync(join(dir, 'installed.json'), JSON.stringify({ version: '0.0.0', model: 'other' }));
  assert.equal(installed(), false);
});

test('after a failed install, two mails in a row trigger no second attempt', async () => {
  // Local provider, not installed: each embed call starts a background install, and a failed one
  // waits 1, 5, then 15 minutes, then an hour. New mail doesn't shortcut that schedule.
  let attempts = 0;
  setInstallSteps(async () => {
    attempts++;
    throw new Error('npm is down');
  });
  const saved = process.env.STAM_EMBEDDER;
  delete process.env.STAM_EMBEDDER;
  try {
    assert.equal(await embed(['first mail']), null);
    for (let i = 0; i < 100 && attempts < 1; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(attempts, 1, 'the first mail starts one install');
    assert.equal(await embed(['second mail']), null);
    assert.equal(await embed(['third mail']), null);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(attempts, 1, 'later mail starts no second install while the retry waits');
  } finally {
    setInstallSteps(undefined);
    process.env.STAM_EMBEDDER = saved;
  }
});

test('the installer retries on its own timer through four failures, then installs with no new mail', async () => {
  // Fake clock: the install fails four times on the schedule (1, 5, 15 minutes, then an hour), and
  // succeeds on the next hourly timer. The backfill hook runs once, and nothing more is attempted.
  const settle = () => new Promise((r) => setImmediate(r));
  let attempts = 0;
  let backfills = 0;
  setInstallSteps(async () => {
    attempts++;
    if (attempts <= 4) throw new Error('npm is down');
  });
  whenInstalled(() => backfills++);
  const saved = process.env.STAM_EMBEDDER;
  delete process.env.STAM_EMBEDDER;
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    assert.equal(await embed(['one mail']), null);
    await settle();
    assert.equal(attempts, 1, 'the first mail starts one install');
    for (const ms of [60_000, 300_000, 900_000]) {
      mock.timers.tick(ms);
      await settle();
    }
    assert.equal(attempts, 4, 'the timer retried on the 1, 5, and 15 minute schedule');
    mock.timers.tick(3_600_000);
    await settle();
    assert.equal(attempts, 5, 'the hourly timer retried and succeeded');
    assert.equal(backfills, 1, 'the backfill hook ran after the install succeeded');
    mock.timers.tick(7_200_000);
    await settle();
    assert.equal(attempts, 5, 'nothing more is attempted once installed');
  } finally {
    mock.timers.reset();
    setInstallSteps(undefined);
    process.env.STAM_EMBEDDER = saved;
  }
});

test('the backfill walks every source with pending refs, a page at a time', async () => {
  // Two sources of 201 refs each: a backfill page is 200, so each source is walked over two pages.
  // Each source's pending lists its refs with no vector yet, up to the limit it's given.
  const pages = { pagedA: [], pagedB: [] };
  const pendingFor = (name) => (model, limit) => {
    const out = [];
    for (let i = 0; i < 201 && out.length < limit; i++) {
      const row = db.embeddingRow(name, `r${i}`);
      if (!row || row.model !== model) out.push(`r${i}`);
    }
    if (out.length) pages[name].push(out.length);
    return out;
  };
  source('pagedA', (ref) => `alpha ${ref}`, pendingFor('pagedA'));
  source('pagedB', (ref) => `beta ${ref}`, pendingFor('pagedB'));
  await backfill();
  for (const name of Object.keys(pages)) {
    for (let i = 0; i < 201; i++) assert.ok(db.embeddingRow(name, `r${i}`), `${name} r${i} was never indexed`);
    assert.ok(pages[name].length >= 2, `${name} walked in ${pages[name].length} page(s)`);
    assert.ok(pages[name][0] <= 200, `${name} first page ${pages[name][0]}`);
  }
});

test('the agent search blends mail and ITSA hits in each route\'s order, cut to any limit', async () => {
  const { blendHits } = await import('../src/hit-blend.ts');
  // A route scores its candidates the way mail-search and itsa-search do: 0.7 × cosine + 0.3 ×
  // keyword / its best keyword, over every candidate it had, then keeps the top of them.
  const route = (cands) => {
    const maxKw = Math.max(1, ...cands.map((h) => h.keyword));
    return cands.map((h) => ({ ...h, score: 0.7 * (h.cosine ?? 0) + 0.3 * (h.keyword / maxKw) })).sort((a, b) => b.score - a.score);
  };
  // Mail A (cosine .9, no keyword) and B (.8, keyword 3), and D (.1, keyword 30) that the route
  // holds: its keyword scale is 30, so B's score is .59, not what a truncated list would give it.
  const mail = route([
    { id: 'A', by: 'meaning', cosine: 0.9, keyword: 0 },
    { id: 'B', by: 'meaning', cosine: 0.8, keyword: 3 },
    { id: 'D', by: 'meaning', cosine: 0.1, keyword: 30 },
  ]);
  const itsa = route([
    { id: 'C', by: 'meaning', cosine: 0.6, keyword: 0 },
    { id: 'E', by: 'meaning', cosine: 0.05, keyword: 2 },
  ]);
  assert.equal(mail[1].id, 'B');
  assert.ok(Math.abs(mail[1].score - (0.56 + 0.3 * 3 / 30)) < 1e-9, `${mail[1].score}`);
  const full = blendHits([mail, itsa]);
  assert.equal(full.by, 'meaning');
  assert.deepEqual(full.hits.map((h) => h.id), ['A', 'B', 'C', 'D', 'E']);
  // Cut each route to its top `limit`: the overall top `limit` is the same as over the full lists.
  for (const limit of [1, 2, 3]) {
    const cut = blendHits([mail.slice(0, limit), itsa.slice(0, limit)]).hits.map((h) => h.id);
    assert.deepEqual(cut.slice(0, limit), full.hits.slice(0, limit).map((h) => h.id), `limit ${limit}: ${cut}`);
  }
  // Keyword only (no route ranked by meaning): each list is divided by its own best score, so each
  // list's top is 1 and the order inside a list holds.
  const kw = blendHits([
    [{ id: 'weak', by: 'keyword', score: 2, cosine: null, keyword: 2 }],
    [{ id: 'exact', by: 'keyword', score: 6, cosine: null, keyword: 6 }, { id: 'mid', by: 'keyword', score: 3, cosine: null, keyword: 3 }],
  ]);
  assert.equal(kw.by, 'keyword');
  assert.equal(kw.hits.at(-1).id, 'mid');
  assert.equal(kw.hits.find((h) => h.id === 'mid').score, 0.5);
  assert.deepEqual(blendHits([[], []]).hits, []);
});

test('a text edited while it embeds is embedded again, and its stored hash is the new text\'s', async () => {
  // The edit lands while flush waits on embed: flush must not store the old text's vector under the
  // new text's time, and must queue the item again.
  const texts = { e1: 'first version of the text' };
  source('edited', (ref) => texts[ref]);
  enqueue('edited', 'e1');
  texts.e1 = 'second version, edited mid-embed';
  for (let i = 0; i < 200 && db.embeddingRow('edited', 'e1')?.hash !== hashOf(texts.e1); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(db.embeddingRow('edited', 'e1')?.hash, hashOf(texts.e1), 'the stored hash is the old text\'s');
});

test('the local provider sends the worker one text per model run (S-2127)', async () => {
  // onnxruntime's memory arena keeps the largest buffers a run needed, so 16 padded texts per run
  // held ~1 GB of native memory in the daemon. A fake worker records how many texts each run got.
  const embedderMod = await import('../src/embed.ts');
  const dir = join(process.env.STAM_HOME, 'embedder');
  const pkg = join(dir, 'node_modules', '@huggingface', 'transformers');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{}');
  writeFileSync(join(dir, 'installed.json'), JSON.stringify({ version: embedderMod.LOCAL_VERSION, model: embedderMod.LOCAL_MODEL, revision: embedderMod.LOCAL_REVISION }));
  const runs = join(process.env.STAM_HOME, 'worker-runs');
  const fake = join(process.env.STAM_HOME, 'fake-worker.mjs');
  writeFileSync(
    fake,
    `import { parentPort } from 'node:worker_threads';
import { appendFileSync } from 'node:fs';
parentPort.on('message', ({ id, texts }) => {
  appendFileSync(${JSON.stringify(runs)}, texts.length + '\\n');
  parentPort.postMessage({ id, vecs: texts.map((t) => Float32Array.from([t.length, 0])) });
});
`,
  );
  const saved = { e: process.env.STAM_EMBEDDER, w: process.env.STAM_EMBED_WORKER };
  delete process.env.STAM_EMBEDDER;
  process.env.STAM_EMBED_WORKER = fake;
  try {
    assert.equal(installed(), true);
    const texts = ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff', 'ggggggg'];
    const vecs = await embed(texts);
    assert.deepEqual(vecs.map((v) => v[0]), [1, 2, 3, 4, 5, 6, 7], 'vectors come back in text order');
    const sizes = readFileSync(runs, 'utf8').trim().split('\n').map(Number);
    assert.equal(sizes.length, texts.length);
    assert.ok(sizes.every((n) => n === embedderMod.RUN_BATCH && n === 1), `runs of ${sizes}`);
  } finally {
    await embedderMod.unload();
    saved.e === undefined ? delete process.env.STAM_EMBEDDER : (process.env.STAM_EMBEDDER = saved.e);
    saved.w === undefined ? delete process.env.STAM_EMBED_WORKER : (process.env.STAM_EMBED_WORKER = saved.w);
    rmSync(join(dir, 'installed.json'), { force: true });
  }
});

test('every src module imports on its own, as the deploy check does', () => {
  // stam deploy imports each module as a check (deploy.ts): a module that fails to load on import
  // fails here, not in a live deploy. The worker entry and the CLI are left out, as the deploy does.
  const root = new URL('..', import.meta.url).pathname;
  const modules = readdirSync(join(root, 'src'), { recursive: true })
    .filter((f) => f.endsWith('.ts') && f !== 'cli.ts' && f !== 'embed-worker.ts' && !f.startsWith('adapters/opencode-plugin'))
    .map((f) => `./src/${f}`);
  const home = tempDir('stam-embed-imports-');
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `for (const m of ${JSON.stringify(modules)}) await import(m); process.exit(0);`], {
    cwd: root,
    env: { ...process.env, STAM_HOME: home, STAM_MACHINE: 'deploy-check', STAM_BIND: '127.0.0.1', STAM_EMBEDDER: 'stub' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(r.status, 0, `importing the modules failed:\n${r.stderr}${r.stdout}`);
});
