#!/usr/bin/env node
// Unit tests for S-1171 (the notice after a deploy names added, removed and changed tools, and
// tells a Claude Code agent only that a changed tool's listed schema may be stale) and S-1744
// (one notice per agent per deploy, and no wake for a standing agent). Throwaway STAM_HOME, no
// daemon. Run with `node --test test/tool-changes.test.mjs`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './tmphome.mjs';
import { rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const home = tempHome('stam-tool-changes-');
process.env.STAM_HOME = home;
process.env.STAM_MACHINE = 'tool-changes-test';
process.env.STAM_RELEASE_ID = 'release-a';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];

const tc = await import('../src/tool-changes.ts');
const db = await import('../src/db.ts');
const mail = await import('../src/mail.ts');

const TOOLS = join(home, 'mcp-tools.json');
const NOTICES = join(home, 'mcp-notices.json');
const tools = () => tc.catalog();
// The file a previous release left, with one tool's schema different: the next start sees a change.
const previous = () => ({ ...tools(), read_mail: JSON.stringify(['old description', { type: 'object' }]) });
// The record for one release, or undefined.
const recordOf = (release) => tc.readTold().releases[release];

let seq = 0;
// Retires every agent from an earlier test, so only this test's agents are running to announce to.
function isolate() {
  for (const a of db.listAgents()) db.updateAgent(a.id, { lifecycle: 'archived' });
}
function agent(fields = {}) {
  const id = `tc-agent-${++seq}`;
  db.createAgent({ id, name: id, role: 'dev', machine: 'tool-changes-test', harness: 'fake', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null, ...fields });
  return id;
}
// A daemon start whose tools file is the previous release's: the diff is non-empty every time.
async function trigger() {
  writeFileSync(TOOLS, JSON.stringify(previous()));
  await tc.announceToolChanges();
}

test('a parameter added to a tool shows as changed, and the notice names it and says its listed schema may be stale', () => {
  const tool = (name, props = {}) => ({ name, description: `d ${name}`, inputSchema: { type: 'object', properties: props } });
  const before = tc.catalog([tool('send_mail', { body: {} }), tool('read_mail')]);
  const after = tc.catalog([tool('send_mail', { body: {}, override: {} }), tool('read_mail')]);
  const d = tc.diff(before, after);
  assert.deepEqual(d, { added: [], removed: [], changed: ['send_mail'] });
  const text = tc.noticeText(d, 'claude');
  assert.match(text, /changed: send_mail/);
  assert.match(text, /may be stale/);
  assert.doesNotMatch(text, /reconnect_mcp/);
});

test('added and removed tools are named without the stale-schema hint; no change gives no notice', () => {
  const text = tc.noticeText({ added: ['a'], removed: ['b'], changed: [] });
  assert.match(text, /new: a; removed: b\./);
  assert.doesNotMatch(text, /reconnect_mcp/);
  assert.equal(tc.noticeText({ added: [], removed: [], changed: [] }), undefined);
});

test('only a claude agent gets the stale-schema hint for a changed tool; codex and opencode get the list alone', () => {
  const d = { added: [], removed: [], changed: ['send_mail'] };
  const claude = tc.noticeText(d, 'claude');
  assert.match(claude, /changed: send_mail/);
  assert.match(claude, /may be stale/);
  for (const harness of ['codex', 'opencode']) {
    const text = tc.noticeText(d, harness);
    assert.match(text, /changed: send_mail/);
    assert.doesNotMatch(text, /may be stale/);
  }
  assert.equal(tc.noticeText({ added: [], removed: [], changed: [] }, 'claude'), undefined);
});

test('two or three triggers for the same release give one notice per agent', async () => {
  rmSync(TOOLS, { force: true });
  rmSync(NOTICES, { force: true });
  isolate();
  const a1 = agent();
  const a2 = agent();
  await trigger();
  assert.equal(mail.queuedNoticeCount(a1), 1, 'the first start tells the agent');
  assert.equal(mail.queuedNoticeCount(a2), 1);
  // The tools file is the previous release's again, as a repeat daemon start or a rollback leaves it.
  await trigger();
  await trigger();
  assert.equal(mail.queuedNoticeCount(a1), 1, 'the second and third start add no notice');
  assert.equal(mail.queuedNoticeCount(a2), 1);
  // Two agents for one release, all recorded.
  assert.deepEqual(recordOf('release-a').told, [a1, a2]);
});

test('an interrupted save leaves the previous record; a leftover temp file does not hide it', () => {
  rmSync(NOTICES, { force: true });
  tc.saveTold({ releases: { 'release-a': { d: { added: [], removed: [], changed: ['read_mail'] }, told: ['x'], pending: [] } } });
  assert.equal(existsSync(`${NOTICES}.tmp-${process.pid}`), false, 'a finished save leaves no temp file');
  // A crashed write left a partial temp file next to the good record.
  writeFileSync(`${NOTICES}.tmp-99999`, '{ "releases": { "release-a": { "d": { "added":');
  assert.deepEqual(recordOf('release-a').told, ['x'], 'the good record is read');
});

test('a standing agent is not woken for the notice, and is told only once it is delivered', async () => {
  rmSync(TOOLS, { force: true });
  rmSync(NOTICES, { force: true });
  isolate();
  const s = agent();
  db.updateAgent(s, { standing: 1 });
  await trigger();
  assert.equal(mail.queuedNoticeCount(s), 1, 'the standing agent still sees it on its next wake');
  assert.equal(mail.wakeableNoticeCount(s), 0, 'a passive notice is no reason to wake it');
  assert.deepEqual(recordOf('release-a').pending, [s], 'not told until delivered');
  assert.deepEqual(recordOf('release-a').told, []);
  // A real wake delivers it after a tool call, and nothing queues it again.
  assert.match(mail.inTurnNotice(s) ?? '', /MCP tools changed/);
  assert.equal(mail.queuedNoticeCount(s), 0);
  assert.deepEqual(recordOf('release-a').told, [s], 'delivered, so now told');
  assert.deepEqual(recordOf('release-a').pending, []);
  await trigger();
  assert.equal(mail.queuedNoticeCount(s), 0, 'a later start does not repeat it');
});

test('a standing agent whose notice was never delivered is queued again at the next start', async () => {
  rmSync(TOOLS, { force: true });
  rmSync(NOTICES, { force: true });
  isolate();
  const s = agent();
  db.updateAgent(s, { standing: 1 });
  await trigger();
  assert.equal(mail.queuedNoticeCount(s), 1);
  // The daemon restarts: the in-memory queue is gone, the record still says pending.
  mail.truncateNotices(s, 0);
  assert.equal(mail.queuedNoticeCount(s), 0);
  assert.deepEqual(recordOf('release-a').pending, [s]);
  await trigger();
  assert.equal(mail.queuedNoticeCount(s), 1, 'the next start queues it again');
});

test.after(() => rmSync(home, { recursive: true, force: true }));
