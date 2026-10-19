#!/usr/bin/env node
// Recomputes the files derived from the text of blocks/ and registry/ (S-1371), so an instruction
// edit carries its derived files in the same change:
//   1. each block's summary_of: blockHash of its body (src/blocks.ts);
//   2. test/fixtures/templates/NAME.md: template(NAME) (src/templates.ts);
//   3. test/golden/briefs-dev-change.json: renderBrief with test/golden/briefs-vars.mjs (src/agent-types.ts);
//   4. export/overrides/manifest.json: the hashes apply-overrides.mjs checks (export/override-hashes.mjs).
//      A template or type whose hash changed needs its generic text in export/overrides edited by hand,
//      so the block diff (or brief) to port is printed, from the last commit that had the recorded text.
// --check changes nothing: it lists what is stale and exits 1. Without it, the stale files are written.
// Usage: node scripts/refresh-derived.mjs [--check]
// The derived text is the repo's, never a user's override, so STAM_HOME is always a fresh throwaway folder.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, gitReader, sha, templateText, templateTextIn } from '../export/override-hashes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
if (args.some((a) => a !== '--check')) {
  console.error('usage: node scripts/refresh-derived.mjs [--check]');
  process.exit(2);
}
const home = mkdtempSync(join(tmpdir(), 'stam-refresh-derived-'));
process.env.STAM_HOME = home;
process.on('exit', () => rmSync(home, { recursive: true, force: true }));

// Loaded after STAM_HOME is set: src/config.ts reads it on import.
const src = (f) => pathToFileURL(join(ROOT, 'src', f)).href;
const { blockHash, parseBlock } = await import(src('blocks.ts'));
const { template } = await import(src('templates.ts'));
const { agentType, renderBrief } = await import(src('agent-types.ts'));
const { briefVars } = await import(pathToFileURL(join(ROOT, 'test', 'golden', 'briefs-vars.mjs')).href);

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const changes = []; // { rel, text, why } for every file whose text differs from what it should be
const want = (rel, text, why) => {
  if (!existsSync(join(ROOT, rel)) || read(rel) !== text) changes.push({ rel, text, why });
};

// 1. summary_of: only that line of the frontmatter changes, the rest of the file is kept as it is.
for (const f of readdirSync(join(ROOT, 'blocks'), { recursive: true }).filter((f) => f.endsWith('.md')).sort()) {
  const rel = `blocks/${f}`;
  const raw = read(rel);
  const block = parseBlock(rel, raw);
  const hash = blockHash(block.body);
  if (block.summary_of !== hash) changes.push({ rel, text: raw.replace(/^summary_of:[^\r\n]*/m, `summary_of: ${hash}`), why: 'summary_of' });
}

// 2. The fixtures: one per template name in the folder, each the text template() gives.
const fixtureDir = 'test/fixtures/templates';
for (const f of readdirSync(join(ROOT, fixtureDir)).filter((f) => f.endsWith('.md')).sort()) {
  want(`${fixtureDir}/${f}`, template(f.slice(0, -3)), 'fixture');
}

// 3. The golden briefs: the types the golden names, rendered as the golden test renders them.
const goldenRel = 'test/golden/briefs-dev-change.json';
const goldenTypes = Object.keys(JSON.parse(read(goldenRel)));
want(goldenRel, JSON.stringify(Object.fromEntries(goldenTypes.map((t) => [t, renderBrief(agentType(t), briefVars(t))])), null, 2) + '\n', 'golden');

// 4. The override manifest: the template text and the type entry, as apply-overrides.mjs hashes them.
const manifestRel = 'export/overrides/manifest.json';
const manifest = JSON.parse(read(manifestRel));
const defaults = JSON.parse(read('registry/defaults.json'));
const next = { templates: {}, types: {} };
for (const name of Object.keys(manifest.templates)) next.templates[name] = sha(templateText(ROOT, name));
for (const name of Object.keys(manifest.types)) {
  if (!defaults.types?.[name]) throw new Error(`${manifestRel} has type ${name}, which registry/defaults.json does not`);
  next.types[name] = sha(canonical(defaults.types[name]));
}
const moved = [];
for (const kind of ['templates', 'types']) {
  for (const name of Object.keys(manifest[kind])) if (manifest[kind][name] !== next[kind][name]) moved.push({ kind, name, was: manifest[kind][name] });
}

// The last commit whose file (or type) hashes to the recorded value, or null (no git history, or none matches).
const isRepo = spawnSync('git', ['-C', ROOT, 'rev-parse', '--git-dir']).status === 0;
function recordedCommit(paths, same) {
  if (!isRepo) return null;
  const log = spawnSync('git', ['-C', ROOT, 'log', '--format=%H', '--', ...paths], { encoding: 'utf8' });
  for (const c of log.stdout.split('\n').filter(Boolean)) {
    try {
      if (same(gitReader(ROOT, c))) return c;
    } catch {
      // A commit that lacks the file: not the recorded text.
    }
  }
  return null;
}
const typeEntry = (text, name) => JSON.parse(text).types?.[name];
// registry-types.json keeps its types at the top level, with no `types` key.
const overrideEntry = (text, name) => JSON.parse(text)[name];
for (const m of moved) {
  m.commit = m.kind === 'templates'
    ? recordedCommit([`templates/${m.name}.md`, `blocks/${m.name}`], (r) => sha(templateTextIn(r, m.name)) === m.was)
    : recordedCommit(['registry/defaults.json'], (r) => sha(canonical(typeEntry(r.read('registry/defaults.json'), m.name) ?? null)) === m.was);
}

// The generic text an override keeps: a template's file, or a type's entry in registry-types.json.
const overrideRel = (m) => (m.kind === 'templates' ? `export/overrides/templates/${m.name}.md` : 'export/overrides/registry-types.json');
// Ported: the generic text changed since the recorded commit (HEAD when none matches), so someone edited it.
// Without git nothing counts as ported.
function ported(m) {
  if (!isRepo) return false;
  const base = m.commit ?? 'HEAD';
  const rel = overrideRel(m);
  if (m.kind === 'templates') return spawnSync('git', ['-C', ROOT, 'diff', '--quiet', base, '--', rel]).status === 1;
  let then;
  try {
    then = overrideEntry(gitReader(ROOT, base).read(rel), m.name);
  } catch {
    then = undefined;
  }
  return canonical(overrideEntry(read(rel), m.name) ?? null) !== canonical(then ?? null);
}
// A moved hash is written only once its generic text is ported; until then the old hash stays, so apply-overrides keeps refusing.
for (const m of moved) {
  m.ported = ported(m);
  if (!m.ported) next[m.kind][m.name] = m.was;
}
const unported = moved.filter((m) => !m.ported);
want(manifestRel, JSON.stringify({ ...manifest, ...next }, null, 2) + '\n', 'manifest');

// What a hand edit of export/overrides must port: the diff of the template's files, or the brief, since the recorded commit.
function printPort(m) {
  const { kind, name, commit: c } = m;
  if (kind === 'templates') {
    const paths = [`templates/${name}.md`, `blocks/${name}`];
    console.log(`\nexport/overrides/manifest.json: template ${name} changed. Its generic text, ${overrideRel(m)}, needs the same edit. Block diff${c ? ` since ${c.slice(0, 9)}` : ' (no commit has the recorded text: the current text follows)'}:`);
    if (c) console.log(spawnSync('git', ['-C', ROOT, 'diff', c, '--', ...paths], { encoding: 'utf8' }).stdout);
    else console.log(templateText(ROOT, name));
    return;
  }
  const before = c ? typeEntry(gitReader(ROOT, c).read('registry/defaults.json'), name)?.brief : '(not in the recorded commit)';
  console.log(`\nexport/overrides/manifest.json: type ${name} changed. Its generic brief, ${overrideRel(m)}, needs the same edit. Brief${c ? ` at ${c.slice(0, 9)}` : ' (no commit has the recorded entry)'}:\n  before: ${before}\n  now:    ${defaults.types[name].brief}`);
}

for (const m of moved) printPort(m);
for (const m of unported) console.log(`\nport this into ${overrideRel(m)}, then rerun: the manifest hash for ${m.kind === 'templates' ? 'template' : 'type'} ${m.name} stays as it is until then`);
for (const c of changes) console.log(`${check ? 'stale' : 'refreshed'}: ${c.rel} (${c.why})`);
// A kept hash is not in changes, so its manifest line is listed here when checking.
if (check) for (const m of unported) console.log(`stale: ${manifestRel} (manifest: ${m.kind === 'templates' ? 'template' : 'type'} ${m.name}, not ported)`);
if (check) {
  if (changes.length || moved.length) {
    console.log(`\n${changes.length + moved.length} derived file(s) or hash(es) stale: run node scripts/refresh-derived.mjs${unported.length ? ', after porting the generic text above' : ''}`);
    process.exitCode = 1;
  } else console.log('derived files are current');
} else {
  for (const c of changes) writeFileSync(join(ROOT, c.rel), c.text);
  console.log(changes.length ? `\n${changes.length} derived file(s) written` : 'derived files were already current');
  if (unported.length) {
    console.log(`${unported.length} hash(es) kept: their generic text is not ported yet`);
    process.exitCode = 1;
  }
}
