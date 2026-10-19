#!/usr/bin/env node
// Reviewer agent types (S-412 step 1, src/agent-types.ts, src/reviewer-migrate.ts): the review
// config, validation in saveType, the remove guards, fallbackChain, and the migration of the S-360
// reviewer settings. Throwaway STAM_HOME, no daemon: `node --test test/reviewer-types.test.mjs`.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const home = tempHome('stam-reviewer-types-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `reviewer-types-test-${process.pid}`;
const at = await import('../src/agent-types.ts');
const rm = await import('../src/reviewer-migrate.ts');
const reg = await import('../src/registry.ts');
const rc = await import('../src/reviewer-chain.ts');
const { template } = await import('../src/templates.ts');

const userFile = join(home, 'registry.json');
const user = () => JSON.parse(readFileSync(userFile, 'utf8'));
const writeUser = (o) => writeFileSync(userFile, JSON.stringify(o));
beforeEach(() => rmSync(userFile, { force: true }));

const base = { description: 'x', harness: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
const rev = (over = {}) => ({ ...base, review: { fallback: null, ring: null }, ...over });
const ring = (over = {}) => ({ description: 'r', review: { fallback: null, ring: { format: 'rounds', members: ['reviewer', 'reviewer-opus'], moderator: null, maxRounds: 3, ...over } } });

test('shipped reviewer types, default reviewer, and the registry carry the fields', () => {
  assert.equal(at.defaultReviewer(), 'reviewer');
  assert.deepEqual(at.reviewerTypes().sort(), ['review-ring', 'reviewer', 'reviewer-opus']);
  assert.equal(at.isReviewerType('reviewer'), true);
  assert.equal(at.isReviewerType('developer'), false);
  assert.equal(reg.registry().defaultReviewer, 'reviewer');
  assert.deepEqual(at.agentTypes().reviewer.review, { fallback: 'reviewer-opus', ring: null });
  const rr = at.agentTypes()['review-ring'];
  assert.equal(rr.harness, '');
  assert.equal(rr.review.ring.format, 'rounds');
  assert.equal(rr.review.ring.maxRounds, 3);
  assert.equal(at.agentTypes()['reviewer-opus'].model, 'claude-opus-5-5');
  assert.notEqual(template('type-reviewer-opus'), '');
});

test('a user registry can set the default reviewer, which is read back', () => {
  at.saveType('mine', rev());
  at.setDefaultReviewer('mine');
  assert.equal(at.defaultReviewer(), 'mine');
  assert.throws(() => at.setDefaultReviewer('developer'), /not a reviewer type/);
  assert.throws(() => at.setDefaultReviewer('nope'), /not a reviewer type/);
});

test('saveType: default: true sets the default reviewer; a non-reviewer can not be it', () => {
  at.saveType('mine', rev({ default: true }));
  assert.equal(user().defaultReviewer, 'mine');
  assert.throws(() => at.saveType('plain', { ...base, default: true }), /only a reviewer type/);
});

test('saveType: the fallback must be another existing reviewer type', () => {
  const t = at.saveType('a', rev({ review: { fallback: 'reviewer-opus', ring: null } }));
  assert.equal(t.review.fallback, 'reviewer-opus');
  assert.throws(() => at.saveType('b', rev({ review: { fallback: 'nope', ring: null } })), /fallback nope is not a reviewer type/);
  assert.throws(() => at.saveType('b', rev({ review: { fallback: 'developer', ring: null } })), /developer is not a reviewer type/);
  at.saveType('b', rev());
  assert.throws(() => at.saveType('b', rev({ review: { fallback: 'b', ring: null } })), /its own fallback/);
});

test('saveType: ring members, moderator, and maxRounds are checked', () => {
  const ok = at.saveType('rg', ring({ moderator: { type: 'advisor', decides: true } }));
  assert.deepEqual(ok.review.ring.moderator, { type: 'advisor', decides: true });
  assert.equal(ok.harness, '');
  assert.throws(() => at.saveType('rg', ring({ members: ['reviewer'] })), /at least 2 members/);
  assert.throws(() => at.saveType('rg', ring({ members: ['reviewer', 'ghost'] })), /member ghost/);
  assert.throws(() => at.saveType('rg', ring({ members: ['reviewer', 'rg'] })), /itself/);
  assert.throws(() => at.saveType('rg', ring({ moderator: { type: 'ghost', decides: false } })), /moderator ghost/);
  assert.throws(() => at.saveType('rg', ring({ format: 'loud' })), /format/);
  for (const maxRounds of [0, 1.5, '3', null]) assert.throws(() => at.saveType('rg', ring({ maxRounds })), /maxRounds/);
  assert.equal(at.saveType('rg', ring({ maxRounds: 1 })).review.ring.maxRounds, 1);
});

test('saveType: the harness is required unless the type is a ring', () => {
  assert.throws(() => at.saveType('x', { description: 'x', review: { fallback: null, ring: null } }), /unknown harness/);
  assert.throws(() => at.saveType('x', { description: 'x' }), /unknown harness/);
  assert.throws(() => at.saveType('rg', { ...ring(), harness: 'claude' }), /no harness/);
  at.saveType('rg', ring());
});

test('removeType refuses the default reviewer and any type another names', () => {
  assert.throws(() => at.removeType('reviewer'), /reviewer is the default reviewer/);
  // reviewer-opus is the shipped reviewer's fallback and a member of review-ring
  assert.throws(() => at.removeType('reviewer-opus'), /reviewer-opus is used by .*reviewer/);
  at.saveType('mod', rev());
  at.saveType('rg', ring({ moderator: { type: 'mod', decides: false } }));
  assert.throws(() => at.removeType('mod'), /mod is used by rg/);
  at.saveType('plain', rev());
  at.removeType('plain');
  assert.equal(at.agentTypes().plain, undefined);
  at.removeType('rg');
  at.removeType('mod');
});

test('removeType: a default reviewer set in the user registry is guarded too', () => {
  at.saveType('mine', rev({ default: true }));
  at.saveType('keep', rev());
  at.removeType('keep');
  assert.throws(() => at.removeType('mine'), /default reviewer/);
});

test('fallbackChain is ordered and stops at a cycle', () => {
  assert.deepEqual(at.fallbackChain('reviewer'), ['reviewer-opus']);
  assert.deepEqual(at.fallbackChain('reviewer-opus'), []);
  assert.deepEqual(at.fallbackChain('developer'), []);
  assert.deepEqual(at.fallbackChain('nope'), []);
  at.saveType('c', rev({ review: { fallback: 'reviewer', ring: null } }));
  assert.deepEqual(at.fallbackChain('c'), ['reviewer', 'reviewer-opus']);
  // a cycle written straight into the registry: c -> d -> c
  writeUser({ types: { c: rev({ review: { fallback: 'd', ring: null } }), d: rev({ review: { fallback: 'c', ring: null } }) } });
  assert.deepEqual(at.fallbackChain('c'), ['d']);
  assert.deepEqual(at.fallbackChain('d'), ['c']);
});

test('typeTarget is a type\'s own target, null for a ring; freeFallback skips a ring', () => {
  assert.deepEqual(rc.typeTarget('reviewer'), { harness: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
  assert.equal(rc.typeTarget('review-ring'), null);
  assert.equal(rc.typeTarget('nope'), null);
  // the shipped reviewer falls to reviewer-opus, which bills to a different account than codex
  assert.equal(rc.freeFallback('reviewer').type, 'reviewer-opus');
  writeUser({ types: { c: rev({ review: { fallback: 'review-ring', ring: null } }) } });
  const fb = rc.freeFallback('c');
  assert.equal(fb.type, 'reviewer'); // the ring is skipped, and its own fallback is next
  assert.match(fb.reasons[0], /review-ring is a ring type/);
  assert.match(rc.freeFallback('reviewer-opus').reasons[0], /no fallback type/);
});

// ---- migration of settings.agentTypes.reviewer
const OPUS = { harness: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
const CODEX = { harness: 'codex', model: 'gpt-6.1-sol', effort: 'low' };

test('migration: the old defaults, or nothing, change nothing', () => {
  assert.deepEqual(rm.reviewerMigration(undefined), { changes: [], defaultReviewer: null });
  assert.deepEqual(rm.reviewerMigration({}), { changes: [], defaultReviewer: null });
  const old = { reviewer: { process: 'one', primary: CODEX, fallback: OPUS, models: [], ring: { format: 'rounds', maxRounds: 3 } } };
  assert.deepEqual(rm.reviewerMigration(old), { changes: [], defaultReviewer: null });
});

test('migration: a changed primary goes into the reviewer type, keeping its brief and fallback', () => {
  const p = rm.reviewerMigration({ reviewer: { primary: { harness: 'claude', model: 'claude-sonnet-5-5', effort: 'low' } } });
  assert.equal(p.changes.length, 1);
  const c = p.changes[0];
  assert.equal(c.name, 'reviewer');
  assert.deepEqual([c.input.harness, c.input.model, c.input.effort], ['claude', 'claude-sonnet-5-5', 'low']);
  assert.deepEqual(c.input.review, { fallback: 'reviewer-opus', ring: null });
  assert.match(c.input.brief, /^Review:/);
  assert.equal(p.defaultReviewer, null);
});

test('migration: a fallback other than Opus medium becomes reviewer-fallback; null removes it', () => {
  const p = rm.reviewerMigration({ reviewer: { fallback: { harness: 'claude', model: 'claude-sonnet-5-5', effort: null } } });
  assert.deepEqual(p.changes.map((c) => c.name), ['reviewer-fallback', 'reviewer']);
  assert.equal(p.changes[1].input.review.fallback, 'reviewer-fallback');
  assert.equal(p.changes[1].input.harness, 'codex');
  const n = rm.reviewerMigration({ reviewer: { fallback: null } });
  assert.deepEqual(n.changes.map((c) => c.name), ['reviewer']);
  assert.equal(n.changes[0].input.review.fallback, null);
});

test('migration: a saved fallback with the target of an existing reviewer type maps to that type, not a new one', () => {
  const sonnet = { harness: 'claude', model: 'claude-sonnet-5-5', effort: 'low' };
  // Kim's Opus 5.5 medium: the shipped reviewer-opus, so nothing changes
  assert.deepEqual(rm.reviewerMigration({ reviewer: { fallback: OPUS } }).changes, []);
  // Opus low is no existing type, so it stays a new one
  assert.deepEqual(rm.reviewerMigration({ reviewer: { fallback: { ...OPUS, effort: 'low' } } }).changes.map((c) => c.name), ['reviewer-fallback', 'reviewer']);
  // a user's own type with the saved target is reused
  writeUser({ types: { 'my-sonnet': rev({ ...sonnet, review: { fallback: null, ring: null } }) } });
  const p = rm.reviewerMigration({ reviewer: { fallback: sonnet } });
  assert.deepEqual(p.changes.map((c) => c.name), ['reviewer']);
  assert.equal(p.changes[0].input.review.fallback, 'my-sonnet');
  // a type that falls back to reviewer would make a cycle, so it isn't reused
  writeUser({ types: { 'my-sonnet': rev({ ...sonnet, review: { fallback: 'reviewer', ring: null } }) } });
  assert.deepEqual(rm.reviewerMigration({ reviewer: { fallback: sonnet } }).changes.map((c) => c.name), ['reviewer-fallback', 'reviewer']);
});

test('migration: a ring or several models become reviewer-ring-migrated and the default', () => {
  const models = [CODEX, { harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash', effort: null }, OPUS];
  for (const process of ['ring', 'models']) {
    const p = rm.reviewerMigration({ reviewer: { process, models, ring: { format: 'debate', maxRounds: 2 } } });
    assert.deepEqual(p.changes.map((c) => c.name), ['reviewer-ring-2', 'reviewer-ring-migrated']);
    const r = p.changes[1].input;
    assert.equal(r.harness, '');
    assert.deepEqual(r.review.ring, { format: 'debate', members: ['reviewer', 'reviewer-ring-2', 'reviewer-opus'], moderator: null, maxRounds: 2 });
    assert.equal(p.defaultReviewer, 'reviewer-ring-migrated');
  }
  // a changed primary: the old Codex target keeps its own member instead of resolving to `reviewer`
  const q = rm.reviewerMigration({ reviewer: { process: 'ring', primary: { harness: 'claude', model: 'claude-sonnet-5-5', effort: null }, models: [CODEX, OPUS] } });
  assert.deepEqual(q.changes.map((c) => c.name), ['reviewer', 'reviewer-ring-1', 'reviewer-ring-migrated']);
  assert.deepEqual(q.changes.at(-1).input.review.ring.members, ['reviewer-ring-1', 'reviewer-opus']);
  // one model is not a ring
  assert.deepEqual(rm.reviewerMigration({ reviewer: { process: 'ring', models: [CODEX] } }).changes, []);
});

test('migration applies through the existing helpers, and runMigrateReviewers drops agentTypes', () => {
  const models = [CODEX, { harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash', effort: null }];
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], agentTypes: { reviewer: { process: 'ring', primary: { harness: 'claude', model: 'claude-sonnet-5-5', effort: null }, fallback: null, models, ring: { format: 'fire', maxRounds: 4 } } } }));
  const dry = rm.runMigrateReviewers(false);
  assert.match(dry.text, /Would change/);
  assert.match(dry.text, /default reviewer: reviewer-ring-migrated/);
  assert.equal(existsSync(userFile), false);
  assert.ok('agentTypes' in JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')));
  const done = rm.runMigrateReviewers(true);
  assert.equal(done.code, 0);
  assert.equal(at.defaultReviewer(), 'reviewer-ring-migrated');
  assert.equal(at.agentTypes().reviewer.model, 'claude-sonnet-5-5');
  assert.equal(at.agentTypes().reviewer.review.fallback, null);
  // each member resolves to the target the old models list had, not to the changed reviewer
  const resolved = at.agentTypes()['reviewer-ring-migrated'].review.ring.members.map((m) => rc.typeTarget(m));
  assert.deepEqual(resolved, models);
  assert.equal(at.agentTypes()['reviewer-ring-migrated'].review.ring.format, 'fire');
  assert.equal('agentTypes' in JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')), false);
  assert.match(rm.runMigrateReviewers(true).text, /nothing to migrate/);
});

test('migration refuses, and keeps settings, when the reviewer type is masked', () => {
  writeUser({ types: { reviewer: null } });
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], agentTypes: { reviewer: { fallback: null } } }));
  assert.notEqual(rm.reviewerMigration({ reviewer: {} }).error, undefined);
  const r = rm.runMigrateReviewers(true);
  assert.equal(r.code, 1);
  assert.match(r.text, /Not migrated/);
  assert.ok('agentTypes' in JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')));
});

test('saveType refuses to strip the review config from the default or a referenced fallback', () => {
  const plain = { description: 'x', harness: 'codex', model: 'gpt-6.1-sol', effort: 'low' };
  assert.throws(() => at.saveType('reviewer', plain), /default reviewer/);
  assert.throws(() => at.saveType('reviewer-opus', plain), /fallback of reviewer/);
  at.saveType('mine', rev({ default: true }));
  assert.throws(() => at.saveType('mine', plain), /default reviewer/);
});

test('migration refuses on a peer, which does not hold the registry', () => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ home: 'some-other-machine', agentTypes: { reviewer: { fallback: null } } }));
  for (const apply of [false, true]) {
    const r = rm.runMigrateReviewers(apply);
    assert.equal(r.code, 1);
    assert.match(r.text, /live on some-other-machine/);
  }
  assert.equal(existsSync(userFile), false);
  assert.ok('agentTypes' in JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')));
});

test('a stored agentTypes key is ignored on read', async () => {
  const s = await import('../src/settings.ts');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ peers: [], agentTypes: { reviewer: { process: 'nonsense' } } }));
  assert.equal('agentTypes' in s.settings(), false);
  assert.equal(s.patchSettings({ chiefOfStaff: null }).text !== undefined, true);
});

// The reviewer process prompt (S-412 step 4): rendered from the registry. Each case writes the user
// registry (a null entry removes a shipped type) and reads the prompt back.
const org = await import('../src/org.ts');
const shipped = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'registry', 'defaults.json'), 'utf8')).types;
const reviewerWith = (fallback) => ({ ...shipped.reviewer, review: { fallback, ring: null } });
const backup = (model, effort) => ({ description: 'Backup.', harness: 'claude', model, effort, brief: null, review: null });
const spawnAlone = 'Spawn a reviewer with `spawn_agent` `type` alone, with no harness, model, or preset';
const ringLine = '- `review-ring`: Risky, cross-cutting, or security-sensitive changes: Codex and Opus review in rounds until they agree (ring, rounds, `reviewer` + `reviewer-opus`, at most 3 rounds). Falls back to `reviewer` → `reviewer-opus`.';

test('the reviewer process prompt: the default only, with no other reviewers or fallbacks', () => {
  writeUser({ types: { 'review-ring': null, 'reviewer-opus': null } });
  assert.equal(org.reviewerProcessPrompt(), [
    'Reviews: spawn the default reviewer, `reviewer` (codex gpt-6.1-sol, low).',
    '',
    `${spawnAlone}.`,
  ].join('\n'));
});

test('the reviewer process prompt: the default and a scenario ring, with the shipped fallback', () => {
  assert.equal(org.reviewerProcessPrompt(), [
    'Reviews: spawn the default reviewer, `reviewer` (codex gpt-6.1-sol, low), unless a scenario below fits.',
    '',
    'Other reviewers:',
    ringLine,
    '',
    `${spawnAlone}: stam then uses its fallback reviewer (\`reviewer\` → \`reviewer-opus\`) when its account is held, and the brief says so. A ring reviewer is spawned with \`spawn_agent\` \`type\` like any other, and starts several reviewers and mails you their result.`,
  ].join('\n'));
});

test('the reviewer process prompt: a chain of two names each fallback, and a type in the chain is not listed again', () => {
  writeUser({ types: {
    reviewer: reviewerWith('reviewer-fallback'),
    'reviewer-fallback': { ...backup('claude-opus-5-5', 'low'), review: { fallback: 'reviewer-x', ring: null } },
    'reviewer-x': backup('claude-sonnet-5-5', 'low'),
    'review-ring': null,
    'reviewer-opus': null,
  } });
  assert.equal(org.reviewerProcessPrompt(), [
    'Reviews: spawn the default reviewer, `reviewer` (codex gpt-6.1-sol, low).',
    '',
    'Spawn a reviewer with `spawn_agent` `type` alone, with no harness, model, or preset: stam then uses its fallback reviewer (`reviewer` → `reviewer-fallback` → `reviewer-x`) when its account is held, and the brief says so.',
  ].join('\n'));
});

test('the reviewer process prompt: the live registry, with a user reviewer-fallback (Opus low) as the fallback', () => {
  writeUser({ types: { reviewer: reviewerWith('reviewer-fallback'), 'reviewer-fallback': backup('claude-opus-5-5', 'low') } });
  assert.equal(org.reviewerProcessPrompt(), [
    'Reviews: spawn the default reviewer, `reviewer` (codex gpt-6.1-sol, low), unless a scenario below fits.',
    '',
    'Other reviewers:',
    '- `reviewer-opus`: Backup reviewer when Codex\'s window runs low (claude claude-opus-5-5, medium).',
    ringLine.replace('Falls back to `reviewer` → `reviewer-opus`.', 'Falls back to `reviewer` → `reviewer-fallback`.'),
    '',
    `${spawnAlone}: stam then uses its fallback reviewer (\`reviewer\` → \`reviewer-fallback\`) when its account is held, and the brief says so. A ring reviewer is spawned with \`spawn_agent\` \`type\` like any other, and starts several reviewers and mails you their result.`,
  ].join('\n'));
});

test('the reviewer process prompt: a listed type with no description still renders, with no empty colon', () => {
  writeUser({ types: {
    reviewer: reviewerWith(null),
    'reviewer-opus': { harness: 'claude', model: 'claude-opus-5-5', effort: 'low', review: { fallback: null, ring: null } },
    'review-ring': null,
  } });
  assert.equal(org.reviewerProcessPrompt(), [
    'Reviews: spawn the default reviewer, `reviewer` (codex gpt-6.1-sol, low), unless a scenario below fits.',
    '',
    'Other reviewers:',
    '- `reviewer-opus` (claude claude-opus-5-5, low).',
    '',
    `${spawnAlone}.`,
  ].join('\n'));
});

test('the reviewer process prompt: a default that does not exist, or is not a reviewer type, is said plainly', () => {
  const none = 'No default reviewer is set; spawn a reviewer type from registry_info.';
  writeUser({ defaultReviewer: 'nope' });
  assert.equal(org.reviewerProcessPrompt(), none);
  writeUser({ defaultReviewer: 'developer' });
  assert.equal(org.reviewerProcessPrompt(), none);
});

test('the reviewer process prompt: a malformed registry gives an empty prompt, not a throw', () => {
  writeUser({ types: { 'review-ring': { description: 'r', review: { fallback: null, ring: { format: 'rounds', members: 5, maxRounds: 3 } } } } });
  assert.equal(org.reviewerProcessPrompt(), '');
});
