#!/usr/bin/env node
// Unit tests for the rule classifier (S-213, src/activity-rules.ts): a table of representative
// tool calls and texts with the category the rules must give (or null, left to the model), the
// model and gap marks, and a check that every category the rules use exists in the tree
// (src/activity-categories.ts). Pure functions: no daemon, no database, no models.
// Run with `node --test test/activity-rules.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const rules = await import('../src/activity-rules.ts');
const cats = await import('../src/activity-categories.ts');

const tool = (name, summary) => ({ kind: 'tool', turn: 1, name, summary });
const text = (summary, lastInTurn = false) => ({ item: { kind: 'text', turn: 1, name: null, summary }, lastInTurn });

// [item, expected category or null]. Tool items are [name, summary]; text items use text().
const TABLE = [
  // stam tools
  [tool('mcp__stam__read_mail', null), 'communicate.read'],
  [tool('mcp__stam__list_inbox', null), 'communicate.read'],
  [tool('ReadNotifications', null), 'communicate.read'],
  [tool('mcp__stam__itsa_create', '{"title":"x"}'), 'track.create'],
  [tool('mcp__stam__itsa_set', '{"ref":"S-1"}'), 'track.status'],
  [tool('mcp__stam__itsa_post', '{"body":"done"}'), 'track.note'],
  [tool('mcp__stam__itsa_link', null), 'track.organize'],
  [tool('mcp__stam__itsa_get', null), 'track.query'],
  [tool('mcp__stam__itsa_list', null), 'track.query'],
  [tool('mcp__stam__search', 'retro'), 'track.query'],
  [tool('mcp__stam__spawn_agent', null), 'delegate.spawn'],
  [tool('Agent', 'review the diff'), 'delegate.spawn'],
  [tool('mcp__stam__find_agents', null), 'delegate.check'],
  [tool('mcp__stam__agent_control', '{"action":"pause","agent":"dev"}'), 'delegate.steer'],
  [tool('mcp__stam__agent_control', '{"action":"stop","agent":"dev"}'), 'delegate.steer'],
  [tool('mcp__stam__agent_control', '{"action":"restart","agent":"dev"}'), 'delegate.steer'],
  [tool('mcp__stam__agent_control', '{"action":"archive","agent":"dev"}'), 'delegate.retire'],
  [tool('mcp__stam__agent_control', '{"action":"shutdown","agent":"dev"}'), 'delegate.retire'],
  [tool('mcp__stam__agent_control', '{"action":"rename","agent":"dev"}'), null],
  [tool('mcp__stam__wait_for', null), 'self.schedule-wait'],
  [tool('mcp__stam__wake_me', null), 'self.schedule-wait'],
  [tool('ScheduleWakeup', null), 'self.schedule-wait'],
  [tool('Monitor', null), 'wait.poll'],
  [tool('mcp__stam__usage_info', null), 'self.budget'],
  [tool('mcp__stam__cost_pause', null), 'self.budget'],
  [tool('ToolSearch', null), 'self.tools'],
  [tool('Skill', 'house-style'), 'self.tools'],
  [tool('mcp__stam__whoami', null), 'self.identity'],
  [tool('mcp__stam__register', null), 'self.identity'],
  [tool('mcp__stam__retro', null), 'self.retro'],
  [tool('mcp__stam__feedback', null), 'self.retro'],
  [tool('mcp__stam__request_permission', null), 'communicate.ask'],
  [tool('mcp__stam__answer_permission', null), 'communicate.answer'],
  [tool('mcp__stam__send_mail', null), null],
  // harness tools
  [tool('WebSearch', 'sqlite wal'), 'understand.external'],
  [tool('WebFetch', 'https://nodejs.org'), 'understand.external'],
  [tool('Grep', 'activity_items'), 'understand.search'],
  [tool('Glob', 'src/**/*.ts'), 'understand.search'],
  [tool('Read', '/home/user/x/CLAUDE.md'), 'understand.task'],
  [tool('Read', '/home/user/x/docs/testing.md'), 'understand.task'],
  [tool('Read', '/home/user/x/.claude/skills/run/SKILL.md'), 'understand.task'],
  [tool('Read', '/tmp/claude-1000/x/tasks/abc.output'), 'understand.output'],
  [tool('Read', '/home/user/x/build.log'), 'understand.output'],
  [tool('Read', '/home/user/x/src/activity.ts'), 'understand.material'],
  [tool('Edit', 'test/activity.test.mjs'), 'produce.tests'],
  [tool('Edit', 'docs/status.md'), 'produce.docs'],
  [tool('Write', 'README.md'), 'produce.docs'],
  [tool('Edit', 'package.json'), 'produce.config'],
  [tool('Edit', 'src/activity.ts'), 'produce.edit'],
  [tool('Write', 'src/activity-rules.ts'), 'produce.write'],
  // shell
  [tool('Bash', 'grep -rn "classify" src | head'), 'understand.search'],
  [tool('Bash', 'rg -n classify src'), 'understand.search'],
  [tool('Bash', 'find src -name "*.ts"'), 'understand.search'],
  [tool('Bash', 'cd /x && git log --oneline -5'), 'understand.history'],
  [tool('Bash', 'git blame src/activity.ts'), 'understand.history'],
  [tool('Bash', 'git diff main...HEAD'), null],
  [tool('Bash', 'git add src/activity-rules.ts && git commit -m "Rules"'), 'integrate.commit'],
  [tool('Bash', 'git merge --no-edit stam/activity-readers'), 'integrate.branch'],
  [tool('Bash', 'git checkout -b stam/activity-rules'), 'integrate.branch'],
  [tool('Bash', 'git push origin stam/activity-rules'), 'integrate.release'],
  [tool('Bash', 'npx tsc --noEmit'), 'verify.static'],
  [tool('Bash', 'npm run build'), 'verify.static'],
  [tool('Bash', 'node --test test/activity-rules.test.mjs'), 'verify.unit'],
  [tool('Bash', 'npx vitest run'), 'verify.unit'],
  [tool('Bash', 'test/run.sh activity e2e-ui'), 'verify.integration'],
  [tool('Bash', 'UI_FLOWS=cards sh test/e2e-ui.sh'), 'verify.integration'],
  [tool('Bash', 'node web/check/phone.mjs --only=360-light'), 'verify.visual'],
  [tool('Bash', 'sh web/check/run.sh phone --only=360-light'), 'verify.visual'],
  [tool('Bash', 'npm ci'), 'operate.install'],
  [tool('Bash', 'uptime && free -h'), 'operate.resources'],
  [tool('Bash', 'cat /proc/loadavg'), 'operate.resources'],
  [tool('Bash', 'ps -ef | grep daemon'), 'understand.state'],
  [tool('Bash', 'kill 12345'), 'operate.service'],
  [tool('Bash', 'rm -rf /tmp/stam-test-abc'), 'operate.cleanup'],
  [tool('Bash', 'sleep 30'), 'wait.sleep'],
  [tool('Bash', 'until grep -q "done" /tmp/x.log; do sleep 5; done'), 'wait.poll'],
  [tool('Bash', 'tail -50 /tmp/claude-1000/x/tasks/abc.output 2>&1'), 'understand.output'],
  [tool('Bash', 'sed -n "1,40p" docs/status.md'), 'understand.task'],
  [tool('Bash', 'sed -i "s/a/b/" src/activity.ts'), 'produce.edit'],
  [tool('Bash', 'sed -i "s/a/b/" test/activity.test.mjs'), 'produce.tests'],
  [tool('Bash', 'echo start && cd src && ls'), 'understand.search'],
  // the parts may name different leaves of the same top-level category: the main one stands
  [tool('Bash', 'npm run build && node --test test/x.test.mjs'), 'verify.static'],
  [tool('Bash', 'sed -n 1,75p src/a.ts; grep -n x src/a.ts'), 'understand.material'],
  [tool('Bash', 'git push origin x && npm run build'), null],
  [tool('exec_command', 'git push'), 'integrate.release'],
  [tool('shell', 'ps aux'), 'understand.state'],
  [tool('Bash', "python3 - <<'EOF'\nimport json\np='src/db.ts'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF"), 'produce.edit'],
  [tool('Bash', "cat > test/activity-stats.test.mjs <<'EOF'\n#!/usr/bin/env node\nEOF"), 'produce.tests'],
  [tool('Bash', 'cat > /tmp/ic-head.txt <<EOF\nhi\nEOF'), 'produce.edit'],
  // a python heredoc that only reads is left to the model
  [tool('Bash', "python3 - <<'EOF'\nprint(open('src/db.ts').read())\nEOF"), null],
  // relative paths follow a simple cd; an unknown directory leaves them to the model
  [tool('Bash', 'cd docs && cat status.md'), 'understand.task'],
  [tool('Bash', 'cd test && sed -i "s/a/b/" fixture.mjs'), 'produce.tests'],
  [tool('Bash', 'cd docs && cat ../src/a.ts'), 'understand.material'],
  [tool('Bash', 'cd ~/projects/x && cat y.ts'), null],
  // text: only the last text of a turn is a summary
  [text('Done: S-213 is on the branch.', true), 'communicate.summary'],
  [text('Running the tests now.', false), null],
];

test('each rule table row gives its expected category, or null', () => {
  for (const [item, want] of TABLE) {
    const it = 'item' in item ? item.item : item;
    const got = rules.classifyByRules(it, { lastInTurn: 'lastInTurn' in item ? item.lastInTurn : false });
    assert.equal(got ? got.category : null, want, `${it.kind} ${it.name ?? ''} ${it.summary ?? ''}`);
  }
});

test('the table has about forty representative items', () => {
  assert.ok(TABLE.length >= 40, `only ${TABLE.length}`);
});

test('every category a rule can give exists in the tree', () => {
  const used = TABLE.map(([item, want]) => want).filter(Boolean);
  for (const c of used) assert.ok(c in cats.ACTIVITY_DEFINITIONS, `${c} is not in the tree`);
  assert.equal(cats.ACTIVITY_KEYS.length, 73);
  assert.equal(cats.ACTIVITY_TREE.length, 13);
  assert.equal(cats.WAIT_KINDS.length, 20);
});

test('classifyItems: model items take the first tool or text of their turn, gaps are derived', () => {
  const items = [
    { kind: 'gap', turn: 1, name: 'prompt', summary: 'hi' },
    { kind: 'model', turn: 2, name: null, summary: null },
    { kind: 'tool', turn: 2, name: 'Bash', summary: 'grep -rn x src' },
    { kind: 'model', turn: 2, name: null, summary: null },
    { kind: 'tool', turn: 2, name: 'Bash', summary: 'node --test a.test.mjs' },
    { kind: 'text', turn: 2, name: null, summary: 'All done.' },
    { kind: 'model', turn: 3, name: null, summary: null },
    { kind: 'tool', turn: 3, name: 'Bash', summary: 'git diff' },
    { kind: 'gap', turn: 3, name: null, summary: null },
  ];
  const c = rules.classifyItems(items);
  assert.deepEqual(c[0], { category: null, source: 'derived', confidence: 1 });
  assert.deepEqual(c[1], { category: 'understand.search', source: 'derived', confidence: 1 });
  assert.deepEqual(c[2], { category: 'understand.search', source: 'rule', confidence: 1 });
  assert.deepEqual(c[3], { category: 'verify.unit', source: 'derived', confidence: 1 });
  assert.deepEqual(c[4], { category: 'verify.unit', source: 'rule', confidence: 1 });
  assert.deepEqual(c[5], { category: 'communicate.summary', source: 'rule', confidence: 1 });
  assert.deepEqual(c[6], { category: null, source: null, confidence: null });
  assert.deepEqual(c[7], { category: null, source: null, confidence: null });
  assert.deepEqual(c[8], { category: null, source: 'derived', confidence: 1 });
});

test('only the last text of a turn is a summary', () => {
  const c = rules.classifyItems([
    { kind: 'text', turn: 1, name: null, summary: 'Let me check.' },
    { kind: 'tool', turn: 1, name: 'Read', summary: 'src/x.ts' },
    { kind: 'text', turn: 1, name: null, summary: 'Found it.' },
  ]);
  assert.equal(c[0].category, null);
  assert.equal(c[2].category, 'communicate.summary');
});

test('a summary cut at the limit goes to the model; the full input at ingest is read whole', () => {
  // 40 long paths: the command is well past the 300-character summary limit.
  const paths = Array.from({ length: 40 }, (_, i) => `src/some/long/directory/name/file-${i}.ts`).join(' ');
  const cmd = `git add ${paths} && git commit -m "x"`;
  const cut = cmd.slice(0, 300);
  assert.equal(cut.length, 300);
  // Backfill: only the summary; cut, so the rules don't guess.
  assert.equal(rules.classifyByRules(tool('Bash', cut)), null);
  // Ingest: the full input is there, and the command settles.
  assert.equal(rules.classifyByRules({ ...tool('Bash', cut), input: { command: cmd } }).category, 'integrate.commit');
  // A full command whose parts differ in top-level category stays with the model, even when whole.
  const mixed = `git add ${paths} && npm ci`;
  assert.equal(rules.classifyByRules({ ...tool('Bash', mixed.slice(0, 300)), input: { command: mixed } }), null);
});

test('a python heredoc counts as a write only with a real write call', () => {
  assert.equal(rules.classifyByRules(tool('Bash', "python3 - <<'EOF'\nprint(open('src/db.ts').read())\nEOF")), null);
  assert.equal(rules.classifyByRules(tool('Bash', "python3 - <<'EOF'\nopen('src/db.ts', 'a').write('x')\nEOF")).category, 'produce.edit');
  assert.equal(rules.classifyByRules(tool('Bash', "python3 - <<'EOF'\nimport os\nos.replace('a.tmp', 'src/db.ts')\nEOF")).category, 'produce.edit');
});
