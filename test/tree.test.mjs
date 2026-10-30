#!/usr/bin/env node
// The shared tree helper (S-1391, src/tree.ts): children and descendants include agents remembered from
// the peer machine, local-only trees read as before, and nothing else calls db.childrenOf (S-1156, S-1379).
// Run with `node --test test/tree.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-tree-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `tree-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
writeFileSync(join(home, 'settings.json'), JSON.stringify({ cost: { instructions: 'pace it' } }));
const db = await import('../src/db.ts');
const tree = await import('../src/tree.ts');

const mk = (id, parent) => db.createAgent({ id, name: id, role: 'developer', machine: 'here', harness: 'claude', model: 'm', effort: 'low', cwd: '/tmp', parent_id: parent ?? null, session_id: null });

test('a local-only tree reads as db.childrenOf does', () => {
  mk('root');
  mk('a', 'root');
  mk('b', 'a');
  assert.deepEqual(tree.childrenOf('root'), ['a']);
  assert.deepEqual([...tree.descendantsOf('root')].sort(), ['a', 'b']);
});

test('a child on the peer machine counts, and its own children are walked', () => {
  db.rememberPeerAgent({ id: 'p1', name: 'p1', machine: 'there', parents: ['root'] });
  db.rememberPeerAgent({ id: 'p2', name: 'p2', machine: 'there', parents: ['p1'] });
  assert.deepEqual(tree.childrenOf('root').sort(), ['a', 'p1']);
  assert.deepEqual([...tree.descendantsOf('root')].sort(), ['a', 'b', 'p1', 'p2']);
  assert.deepEqual(db.childrenOf('root'), ['a']);
});

// S-4356: GET /api/usage for an agent's token walks every tree above it (usage-scope visibleAgents), and
// reading the peer links per node parsed every remembered peer agent each time: 14 s live.
test('a walk reads the peer links once and finds what a per-node walk finds, in the same order', () => {
  mk('w0');
  for (let i = 1; i <= 30; i++) mk(`w${i}`, `w${Math.floor((i - 1) / 3)}`);
  for (let i = 0; i < 20; i++) db.rememberPeerAgent({ id: `wp${i}`, name: `wp${i}`, machine: 'there', parents: [`w${i}`, `w${i + 1}`] });
  mk('wl', 'wp3');
  const perNode = (id, seen = new Set()) => {
    for (const c of tree.childrenOf(id)) {
      if (seen.has(c)) continue;
      seen.add(c);
      perNode(c, seen);
    }
    return seen;
  };
  const d = db.open();
  const prepare = d.prepare;
  let reads = 0;
  d.prepare = function (sql) {
    if (/FROM peer_agents WHERE parents/.test(sql)) reads++;
    return prepare.call(this, sql);
  };
  let got;
  try {
    got = [...tree.descendantsOf('w0')];
  } finally {
    d.prepare = prepare;
  }
  assert.equal(reads, 1);
  assert.deepEqual(got, [...perNode('w0')]);
  assert.ok(got.includes('wl') && got.includes('wp19'));
});

test('an agent adopted by several parents shows under each, once', () => {
  db.rememberPeerAgent({ id: 'p1', name: 'p1', machine: 'there', parents: ['root', 'a'] });
  assert.deepEqual(tree.childrenOf('a').sort(), ['b', 'p1']);
});

// Source files under src/, with their text, for the gates.
const sources = () => {
  const src = resolve(fileURLToPath(import.meta.url), '../../src');
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) out.push({ name: e.name, text: readFileSync(p, 'utf8') });
    }
  };
  walk(src);
  return out;
};

test('gate: db.childrenOf is called only in src/tree.ts', () => {
  const hits = sources().filter((f) => f.name !== 'tree.ts' && f.name !== 'db.ts' && /\bdb\.childrenOf\(/.test(f.text)).map((f) => f.name);
  assert.deepEqual(hits, [], 'use childrenOf from src/tree.ts: db.childrenOf misses children on the peer machine');
});

// S-1447: the first gate passed while four callers read agent_parents in raw SQL. Reading the table, or
// the agents.parent_id column in SQL, belongs to tree.ts and db.ts; everyone else uses tree.edges. The
// allowlist is for writes: cost-switch moves a predecessor's children onto its successor.
test('gate: agent_parents and agents.parent_id are read only in src/tree.ts and src/db.ts', () => {
  const allowed = new Set(['tree.ts', 'db.ts', 'cost-switch.ts']);
  const hits = sources().filter((f) => !allowed.has(f.name) && rawParentSql(f.text, f.name)).map((f) => f.name);
  assert.deepEqual(hits, [], 'walk parent links through tree.edges/childrenOf/descendantsOf in src/tree.ts: raw walks miss children on the peer machine');
});

// The gate walks the TypeScript AST, so it reads whole string and template literals (SQL split over lines, or
// selecting parent_id before FROM agents, is caught) and comments, regex literals and nested templates can't
// confuse it (S-1620). SQL joined across several literals is not seen.
const PARENT_SQL = /\bagent_parents\b|\bagents\.parent_id\b|\b(?:FROM|JOIN)\s+agents\b[\s\S]*\bparent_id\b|\bparent_id\b[\s\S]*\b(?:FROM|JOIN)\s+agents\b/i;
const rawParentSql = (text, name = 'x.ts') => {
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  let hit = false;
  const visit = (n) => {
    if (hit) return;
    let lit;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) lit = n.text;
    else if (ts.isTemplateExpression(n)) lit = n.head.text + n.templateSpans.map((sp) => ` ${sp.literal.text}`).join('');
    if (lit !== undefined && PARENT_SQL.test(lit)) hit = true;
    else ts.forEachChild(n, visit);
  };
  visit(file);
  return hit;
};

test('gate: the raw parent SQL check sees multi-line SQL and parent_id before FROM agents (S-1620)', () => {
  assert.ok(rawParentSql("db.prepare('SELECT child_id FROM agent_parents')"));
  assert.ok(rawParentSql("db.prepare('SELECT id, parent_id FROM agents')"));
  assert.ok(rawParentSql('db.prepare(`\n  SELECT id\n  FROM agents\n  WHERE parent_id = ?\n`)'));
  assert.ok(rawParentSql('db.prepare(`SELECT a.id,\n a.parent_id\n FROM agents a`)'));
  assert.ok(rawParentSql("db.prepare('SELECT a.id FROM tasks t JOIN agents a ON a.id = t.agent_id WHERE a.parent_id = ?')"));
  assert.ok(rawParentSql("// see processes/*.yaml\ndb.prepare('SELECT child_id FROM agent_parents')"), 'a /* in a line comment opens no block comment');
  assert.ok(rawParentSql("const g = 'Bash(*/.ssh/*)';\ndb.prepare('SELECT child_id FROM agent_parents')"), 'a /* in a string opens no block comment');
  // The daemon.ts:170 line flips the backtick parity of a regex lexer; the `/*` in the next template then
  // opened a fake block over the SQL. The 114c66e2 tokenizer missed this; the AST walk does not.
  assert.ok(rawParentSql("if (shell) return [text, ...paths.map((p) => `'${p.replace(/'/g, `'\\\\''`)}'`)].join(' ');\nconst z = `/*`;\ndb.prepare('SELECT child_id FROM agent_parents');\n/* end */\n"), 'nested templates then a /* in a template');
  assert.ok(rawParentSql('const q = `SELECT parent_id, ${cols} FROM agents`;'), 'a template with a substitution');
  assert.ok(!rawParentSql("db.prepare('SELECT id FROM agents WHERE lifecycle = ?')"));
  assert.ok(!rawParentSql('// SELECT id, parent_id FROM agents\nconst x = 1;'));
});

test('agent costs: a local child under a peer parent counts in the root tree (agent-costs, was raw agent_parents)', async () => {
  const ac = await import('../src/agent-costs.ts');
  ac.resetAgentCostsMemo();
  mk('acR');
  db.rememberPeerAgent({ id: 'acP', name: 'acP', machine: 'there', parents: ['acR'] });
  mk('acL', 'acP');
  db.open().prepare('INSERT INTO usage (agent_id, day, harness, model, account, cost_usd) VALUES (?, ?, ?, ?, ?, ?)').run('acL', '2026-10-13', 'claude', 'm', 'claude', 7);
  const costs = ac.agentCosts(db.listAgents());
  assert.equal(costs.get('acR').tree.api, 7);
});

test('attribution treeSummary members include a peer child, as treeMembers does', async () => {
  const attr = await import('../src/attribution.ts');
  db.rememberPeerAgent({ id: 'p3', name: 'p3', machine: 'there', parents: ['root'] });
  assert.ok(attr.treeMembers('root').has('p3'));
  const s = attr.treeSummary('root', Date.now(), []);
  assert.ok(JSON.stringify(s.members).includes('p3'), JSON.stringify(s.members));
});

test('a fresh peer spawn is remembered with its parent_id, so it counts before the next listing', () => {
  mk('mgr');
  db.rememberPeerAgent({ id: 'fresh', name: 'fresh', machine: 'there', parent_id: 'mgr' });
  assert.deepEqual(tree.childrenOf('mgr'), ['fresh']);
  // A later listing with every parent replaces it; one without parents keeps what is known.
  db.rememberPeerAgent({ id: 'fresh', name: 'fresh', machine: 'there', lifecycle: 'working' });
  assert.deepEqual(tree.childrenOf('mgr'), ['fresh']);
});

test('a manager with only a peer child gets the cost prompt (org.managerCostPrompt)', async () => {
  const org = await import('../src/org.ts');
  mk('solo');
  assert.equal(org.managerCostPrompt(db.getAgent('solo')), '');
  db.rememberPeerAgent({ id: 'solo-kid', name: 'solo-kid', machine: 'there', parents: ['solo'] });
  assert.notEqual(org.managerCostPrompt(db.getAgent('solo')), '');
});

test('a chain local R, peer P, local L: treeSummary members, treeMembers and treeShare all reach L', async () => {
  const attr = await import('../src/attribution.ts');
  mk('R');
  db.rememberPeerAgent({ id: 'P', name: 'P', machine: 'there', parents: ['R'] });
  mk('L', 'P');
  assert.deepEqual([...attr.treeMembers('R')].sort(), ['L', 'P', 'R']);
  const s = attr.treeSummary('R', Date.now(), []);
  for (const id of ['R', 'P', 'L']) assert.ok(s.members.includes(id), id);
  assert.equal(attr.treeShare('R', 'acct', 'w', undefined, { since: 0, agents: { L: 12 } }), 12);
});

test('cost-pause walks a local L under a remembered peer P (cost-pause treeAgents)', async () => {
  const cp = await import('../src/cost-pause.ts');
  mk('cpR');
  db.rememberPeerAgent({ id: 'cpP', name: 'cpP', machine: 'there', parents: ['cpR'] });
  mk('cpL', 'cpP');
  assert.deepEqual(cp.treeAgents(db.getAgent('cpR')).map((a) => a.id).sort(), ['cpL', 'cpR']);
});

test('a busy peer child counts in tree.busyDescendantCount, and quiets when it goes idle (S-1652)', () => {
  mk('bm');
  assert.equal(tree.busyDescendantCount('bm'), 0);
  db.rememberPeerAgent({ id: 'bk', name: 'bk', machine: 'there', lifecycle: 'active', parents: ['bm'], activity: 'working' });
  assert.equal(tree.busyDescendantCount('bm'), 1);
  db.rememberPeerAgent({ id: 'bk', name: 'bk', machine: 'there', lifecycle: 'active', parents: ['bm'], activity: 'idle' });
  assert.equal(tree.busyDescendantCount('bm'), 0);
  // A pending request on the peer keeps it busy; a busy local agent below a peer one counts too.
  db.rememberPeerAgent({ id: 'bk', name: 'bk', machine: 'there', lifecycle: 'active', parents: ['bm'], activity: 'idle', pending_requests: 1 });
  mk('bl', 'bk');
  db.updateAgent('bl', { activity: 'working' });
  assert.equal(tree.busyDescendantCount('bm'), 2);
  // An archived peer agent is not busy.
  db.rememberPeerAgent({ id: 'bk', name: 'bk', machine: 'there', lifecycle: 'archived', parents: ['bm'], activity: 'working' });
  assert.equal(tree.busyDescendantCount('bm'), 1);
});
