#!/usr/bin/env node
// Unit tests for Settings › Skills (S-889, src/instructions.ts) against a throwaway HOME and
// STAM_HOME, no daemon, no model: the SKILL.md frontmatter parser (plain, quoted, folded), skillInfos
// (source user/stam/imported, size in tokens, reach per harness read from the disk), and linkSkills
// into ~/.agents/skills, which replaces only links into stam's skill folders and never touches a
// real file or someone else's link. Run with `node --test test/skills.test.mjs`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, tempHome } from './tmphome.mjs';

const home = tempHome('stam-skills-');
const user = tempDir('stam-skills-user-');
process.env.STAM_HOME = home;
process.env.HOME = user;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'STAM_MACHINE', 'STAM_AGENTS_SKILLS']) delete process.env[k];

let ins;
const skill = (dir, name, fm, body = 'Do the thing.\n') => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n${fm}\n---\n${body}`);
};

before(async () => {
  skill(join(user, '.claude', 'skills'), 'user-style', 'description: How to write to the user.');
  skill(join(home, 'skills'), 'own', 'description: >\n  Folded line one\n  and two.');
  skill(join(home, 'skills'), 'fetched', 'description: "Quoted: yes"');
  writeFileSync(join(home, 'skills', 'fetched', 'origin.json'), '{}');
  writeFileSync(join(home, 'skills', 'fetched', 'extra.md'), 'x'.repeat(400));
  ins = await import('../src/instructions.ts');
});

test('parseSkill reads plain, quoted and folded descriptions and strips the frontmatter', () => {
  assert.equal(ins.parseSkill('---\nname: a\ndescription: Plain one\n---\nBody').description, 'Plain one');
  assert.equal(ins.parseSkill('---\ndescription: \'Q\'\n---\nB').description, 'Q');
  assert.equal(ins.parseSkill('---\ndescription: >\n  a\n  b\nname: n\n---\nB').description, 'a b');
  assert.equal(ins.parseSkill('---\nname: a\n---\nBody').body, 'Body');
  assert.equal(ins.parseSkill('no frontmatter').description, '');
});

test('skillInfos gives source, size and reach per harness', () => {
  const by = Object.fromEntries(ins.skillInfos().map((s) => [s.name, s]));
  assert.equal(by['user-style'].source, 'user');
  assert.equal(by.own.source, 'stam');
  assert.equal(by.own.description, 'Folded line one and two.');
  assert.equal(by.fetched.source, 'imported');
  assert.ok(by['user-style'].tokens > 0);
  assert.ok(by.fetched.extraTokens >= 100, 'origin.json and extra.md count apart from SKILL.md');
  assert.equal(by.own.extraTokens, 0);
  assert.deepEqual(by.own.reaches, { claude: 'native', opencode: 'unreachable', codex: 'unreachable' });
});

test('linkSkills into ~/.agents/skills makes Codex reach every skill and keeps what is not stam\'s', () => {
  const dir = ins.agentsSkillsDir();
  assert.equal(dir, join(user, '.agents', 'skills'));
  mkdirSync(dir, { recursive: true });
  // A real folder, a foreign link and a stale stam link.
  skill(dir, 'own', 'description: the user\'s own skill of the same name');
  const foreign = tempDir('stam-skills-foreign-');
  symlinkSync(foreign, join(dir, 'foreign'));
  symlinkSync(join(home, 'skills', 'gone'), join(dir, 'gone'));
  // The user's own links into the Claude folder: an alias name, and a non-skill file.
  symlinkSync(join(user, '.claude', 'skills', 'user-style'), join(dir, 'alias'));
  writeFileSync(join(user, '.claude', 'notes.md'), 'x');
  symlinkSync(join(user, '.claude', 'skills', 'user-style', 'SKILL.md'), join(dir, 'file'));
  ins.linkSkills(dir);
  assert.ok(!lstatSync(join(dir, 'own')).isSymbolicLink(), 'a real folder stays');
  assert.equal(readlinkSync(join(dir, 'foreign')), foreign, 'a foreign link stays');
  assert.ok(lstatSync(join(dir, 'alias')).isSymbolicLink() && lstatSync(join(dir, 'file')).isSymbolicLink(), 'the user\'s own links into the Claude folder stay');
  assert.ok(!existsSync(join(dir, 'gone')) && (() => { try { lstatSync(join(dir, 'gone')); return false; } catch { return true; } })(), 'a stale stam link is removed');
  assert.equal(readlinkSync(join(dir, 'user-style')), join(user, '.claude', 'skills', 'user-style'));
  const by = Object.fromEntries(ins.skillInfos().map((s) => [s.name, s]));
  assert.equal(by['user-style'].reaches.codex, 'native');
  assert.equal(by.own.reaches.codex, 'unreachable', 'the user\'s folder of the same name is a different skill');
  assert.equal(by.fetched.reaches.codex, 'native');
  ins.linkSkills(dir); // idempotent
  assert.equal(readlinkSync(join(dir, 'fetched')), join(home, 'skills', 'fetched'));
});

test('linkSkills leaves a target that is, or sits in, a source folder alone', () => {
  const via = join(tempDir('stam-skills-via-'), 'skills');
  symlinkSync(join(user, '.claude', 'skills'), via);
  ins.linkSkills(via);
  assert.ok(!existsSync(join(user, '.claude', 'skills', 'own')), 'nothing written into the Claude folder');
  const inside = join(home, 'skills', 'nested');
  ins.linkSkills(inside);
  assert.ok(!existsSync(join(home, 'skills', 'nested', 'own')));
});

test('STAM_AGENTS_SKILLS moves the Codex folder, so a test never touches the real one', () => {
  const elsewhere = join(tempDir('stam-skills-elsewhere-'), 'agents-skills');
  process.env.STAM_AGENTS_SKILLS = elsewhere;
  try {
    assert.equal(ins.agentsSkillsDir(), elsewhere);
    ins.linkSkills(ins.agentsSkillsDir());
    assert.ok(existsSync(join(elsewhere, 'own', 'SKILL.md')));
  } finally {
    delete process.env.STAM_AGENTS_SKILLS;
  }
});
