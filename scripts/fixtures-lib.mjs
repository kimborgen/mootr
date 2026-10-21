// The cross-language fixtures (S-2386): the inputs of every case, and the runner that turns an input
// into the output today's TS code gives. scripts/fixtures-regen.mjs writes api/fixtures/NAME/cases.json
// from this; test/fixtures-ts.test.mjs runs the files back through the same runners. The Go daemon's
// ports read the same files (api/fixtures/README.md). Pure code only: a throwaway STAM_HOME is set up
// so the few modules that import the db (waits, embed) load without touching a real one.
import { tempDir } from '../test/tmphome.mjs';
import { envVar, setEnvVar } from '../src/env.ts';

setEnvVar('HOME', envVar('HOME') ?? tempDir('stam-fixtures-'));
setEnvVar('EMBEDDER', 'stub');

const { isBroadKill, guardOutput } = await import('../src/guard.ts');
const { nextCron } = await import('../src/waits.ts');
const { stubVector } = await import('../src/embed.ts');
const { apply, emptyLayout } = await import('../src/layout-ops.ts');
const { parseProcessText } = await import('../src/process-validate.ts');
const labels = await import('../src/tool-name-labels.ts');
const { toolIcon } = await import('../src/tool-icons.ts');
const { isSystemNotice } = await import('../src/mail-notice.ts');

const errMessage = (e) => (e instanceof Error ? e.message : String(e));
const attempt = (fn) => {
  try {
    return fn();
  } catch (e) {
    return { error: errMessage(e) };
  }
};

// --- guard: input { command, tool_name? }, output { broad } or, with hook: true, { hook } ---------------------
const KILLS = [
  'pkill -f web/check/daemon.sh', 'pkill daemon', 'killall node', 'sudo killall -9 chromium', 'echo ok; pkill -f x',
  'true && pkill -f x', 'false || killall node', 'env FOO=1 pkill x', 'xargs pkill x', 'bash -c "pkill -f x"',
  'echo $(pkill x)', 'echo `killall node`', 'pgrep -f daemon.sh | xargs kill', 'pgrep -f daemon.sh | xargs -r kill -9',
  'pidof node | xargs kill', 'kill $(pgrep -f daemon.sh)', 'kill `pgrep daemon`', 'kill "$(pgrep -f daemon.sh)"',
  'for p in $(pgrep -f daemon.sh); do kill $p; done', 'for p in $(pgrep -f daemon.sh); do\n  kill "$p"\ndone',
  "ps aux | grep daemon | awk '{print $2}' | xargs kill", "kill $(ps -ef | grep web/check | awk '{print $2}')",
  'cd /repo && git status && pkill -f stam-daemon',
  'pkill -9 -f stam', 'sudo pkill -f x', 'pgrep -f daemon.sh | sudo xargs kill',
];
const PASSES = [
  'kill 1234', 'kill -9 1234', 'kill %1', 'kill $!', 'kill "$PID"', 'kill -0 1234', 'kill -s 0 1234', 'kill -0 $(pgrep -f x)',
  'kill $(cat /tmp/x/daemon.pid)', 'kill -l', 'ps -p 1234 -o pid,cmd', 'pgrep -f daemon.sh', 'ps -p 1234 -o cmd; kill -0 1234',
  'ps aux | grep node; kill "$PID"', 'echo $(pgrep x); kill 1234', 'echo "Use pkill -f only in examples"',
  'rg "avoid killall node" docs', 'git commit -m "Block pkill -f in agents"', 'echo hi # pkill -f x',
  'cat <<EOF > notes.txt\npkill -f x\nkillall node\nEOF\nls', "cat <<'EOF'\nkill $(pgrep x) | xargs kill\nEOF",
  'echo npkill is fine', 'node web/check/daemon.sh & echo $! > x.pid', 'ls -la', 'echo "unterminated', '',
  'kill -TERM 4321', 'ps -p "$PID"; kill %1', 'ps aux | grep " kill "',
  'npm test 2>&1 | tail -20', 'git log --oneline | head -5',
];
const guard = [
  ...KILLS.map((command) => ({ name: `refuses ${JSON.stringify(command)}`, input: { command } })),
  ...PASSES.map((command) => ({ name: `allows ${JSON.stringify(command)}`, input: { command } })),
  { name: 'hook denies a broad kill on Bash', input: { hook: true, tool_name: 'Bash', command: 'pkill -f daemon.sh' } },
  { name: 'hook says nothing for an allowed kill', input: { hook: true, tool_name: 'Bash', command: 'kill 1234' } },
  { name: 'hook says nothing for another tool', input: { hook: true, tool_name: 'Edit', command: 'pkill x' } },
  { name: 'hook says nothing without a command', input: { hook: true, tool_name: 'Bash' } },
];
const runGuard = ({ hook, tool_name, command }) =>
  hook ? { hook: guardOutput({ tool_name, tool_input: command === undefined ? {} : { command } }) } : { broad: isBroadKill(command) };

// --- cron: input { spec, from, tz }, output { next } (ISO, UTC) or { error } ------------------------------------
const cron = [
  ['every minute', '* * * * *', '2027-01-15T10:20:30Z'],
  ['exact minute moves to the next', '* * * * *', '2027-01-15T10:20:00Z'],
  ['every 15 minutes', '*/15 * * * *', '2027-01-15T10:20:30Z'],
  ['daily at 06:00, before', '0 6 * * *', '2027-01-15T05:59:00Z'],
  ['daily at 06:00, after', '0 6 * * *', '2027-01-15T06:00:00Z'],
  ['list of hours', '0 9,13,17 * * *', '2027-01-15T10:00:00Z'],
  ['range with step', '0-30/10 8 * * *', '2027-01-15T08:11:00Z'],
  ['start with step', '5/20 * * * *', '2027-01-15T10:30:00Z'],
  ['weekdays at 09:30', '30 9 * * 1-5', '2027-01-16T12:00:00Z'],
  ['Sunday as 0', '0 0 * * 0', '2027-01-15T12:00:00Z'],
  ['Sunday as 7', '0 0 * * 7', '2027-01-15T12:00:00Z'],
  ['day of month', '0 12 20 * *', '2027-01-15T12:00:00Z'],
  ['day of month and weekday both restricted (either matches)', '0 12 20 * 1', '2027-01-15T12:00:00Z'],
  ['month', '0 0 1 6 *', '2027-01-15T12:00:00Z'],
  ['leap day', '0 0 29 2 *', '2027-01-15T12:00:00Z'],
  ['extra spaces', '  */30   *  *  *  * ', '2027-01-15T10:20:30Z'],
  ['year rollover', '0 0 1 1 *', '2027-12-31T23:59:00Z'],
  ['a */2 day of month with a restricted weekday (a star-led field counts as unrestricted: both must match)', '0 12 */2 * 1', '2027-01-15T12:00:00Z'],
  ['Oslo, local time', '0 6 * * *', '2027-01-15T05:30:00Z', 'Europe/Oslo'],
  ['Oslo, summer time', '0 6 * * *', '2027-07-15T03:30:00Z', 'Europe/Oslo'],
  ['Helsinki, spring-forward gap hour is skipped', '* 3 * * *', '2027-03-28T00:30:00Z', 'Europe/Helsinki'],
  ['Helsinki, a real time on the gap day', '*/15 9 * * *', '2027-03-28T00:30:00Z', 'Europe/Helsinki'],
  ['Helsinki, fall-back day, 02:45 from the day before', '45 2 * * *', '2027-10-30T12:00:00Z', 'Europe/Helsinki'],
  ['Helsinki, fall-back day, 03:45 from the day before', '45 3 * * *', '2027-10-30T12:00:00Z', 'Europe/Helsinki'],
  ['Helsinki, fall-back day, 03:45 from before the first 03:45', '45 3 * * *', '2027-10-31T00:30:00Z', 'Europe/Helsinki'],
  ['Helsinki, fall-back day, 03:45 from after the first 03:45', '45 3 * * *', '2027-10-31T00:50:00Z', 'Europe/Helsinki'],
  ['Helsinki, fall-back day, 03:45 from inside the repeated hour', '45 3 * * *', '2027-10-31T01:10:00Z', 'Europe/Helsinki'],
  ['too few fields', '* * * *', '2027-01-15T10:00:00Z'],
  ['too many fields', '* * * * * *', '2027-01-15T10:00:00Z'],
  ['minute out of range', '60 * * * *', '2027-01-15T10:00:00Z'],
  ['hour out of range', '0 24 * * *', '2027-01-15T10:00:00Z'],
  ['reversed range', '0 10-5 * * *', '2027-01-15T10:00:00Z'],
  ['zero step', '*/0 * * * *', '2027-01-15T10:00:00Z'],
  ['not a number', 'a * * * *', '2027-01-15T10:00:00Z'],
  ['empty field list', ', * * * *', '2027-01-15T10:00:00Z'],
  ['never fires', '0 0 31 2 *', '2027-01-15T10:00:00Z'],
].map(([name, spec, from, tz = 'UTC']) => ({ name, input: { spec, from, tz } }));
const runCron = ({ spec, from, tz }) => {
  process.env.TZ = tz;
  return attempt(() => ({ next: nextCron(spec, new Date(from)).toISOString() }));
};

// --- embedder: input { text }, output { dim, idx, val }: the vector's nonzero entries (float32 values) --------
const embedder = [
  '', 'a the of', 'database', 'Database', 'databases', 'Users keep getting redirected back to sign-in',
  'The migration failed while running', 'jumped jumping jumps', 'class glass pass', 'ed ing s', 'running', 'runs',
  'Fix the login redirect loop for SSO users', 'review the pull request and merge when the gates pass',
  'abc123 def456 abc123', 'under_score-dash.dot/slash', 'ÅÆØ ünïcode wörds and emoji 🎉 tést',
  'The deploy watcher holds the release until the hold file is cleared, then deploys storage and closes the ITSA.',
  'tests tests tests tests', 'x'.repeat(64) + ' ' + 'y'.repeat(300),
].map((text) => ({ name: text.length > 40 ? `${text.slice(0, 37)}...` : text || '(empty)', input: { text } }));
const runEmbedder = ({ text }) => {
  const v = stubVector(text);
  const idx = [];
  const val = [];
  v.forEach((x, i) => {
    if (x) {
      idx.push(i);
      val.push(x);
    }
  });
  return { dim: v.length, idx, val };
};

// --- layout-ops: input { start?: Layout, ops }, new pane ids p0, p1, ... in order (the first pane of a world is p_0); output { layout } or { error, at } ---
const W = (key) => ({ op: 'open', world: 'main', key });
const S = (key, split, extra = {}) => ({ op: 'open', world: 'main', key, split, ...extra });
const A_BR = [W('a'), S('b', 'right'), S('c', 'down', { pane: 'p0' })]; // row[a, col[b, c]]
const SETROOT = { id: 'r', split: 'row', children: [{ id: 'x', tabs: ['t1'], active: 't1' }, { id: 'y', tabs: ['t2'], active: 't2' }], sizes: [1, 2] };
const SIDE_WORLD = { ...emptyLayout(), worlds: { side: { root: { id: 's', tabs: [], active: null }, focused: 's' } } };
const layoutOps = [
  ['open in an empty layout', [W('a')]],
  ['open appends after the active tab', [W('a'), W('b'), { ...W('c'), background: true }]],
  ['open of an open tab focuses it', [W('a'), W('b'), W('a')]],
  ['open of an open tab in the background leaves focus', [W('a'), S('b', 'right'), { ...W('a'), background: true }]],
  ['open into a split beside', [W('a'), S('b', 'right')]],
  ['open into a split below, then another beside', [W('a'), S('b', 'down'), S('c', 'right')]],
  ['open with split left and up put the new pane first', [W('a'), S('b', 'left'), S('c', 'up')]],
  ['a second split the same way halves the size and adds a sibling', [W('a'), S('b', 'right'), S('c', 'right'), S('d', 'right', { pane: 'p0' })]],
  ['another direction nests', A_BR],
  ['open with named ids', [W('a'), S('b', 'right', { ids: ['left', 'right'] })]],
  ['open with fewer ids than needed makes up the rest', [W('a'), S('b', 'right', { ids: ['only'] })]],
  ['open into a given pane', [W('a'), S('b', 'right'), W('c')].concat([{ ...W('d'), pane: 'p_0' }])],
  ['bad ids', [W('a'), S('b', 'right', { ids: ['bad id!'] })]],
  ['ids that is not a list', [W('a'), S('b', 'right', { ids: 'p9' })]],
  ['close the active tab keeps the next one active', [W('a'), W('b'), W('c'), { op: 'activate', world: 'main', pane: 'p_0', key: 'b' }, { op: 'close', world: 'main', key: 'b' }]],
  ['close the last tab removes its pane', [W('a'), S('b', 'right'), { op: 'close', world: 'main', key: 'b' }]],
  ['close the first pane of a nested split merges the rest', [...A_BR, { op: 'close', world: 'main', key: 'a' }]],
  ['close leaves a same-direction split that merges into its grandparent, scaling sizes', [W('a'), S('b', 'right'), S('c', 'down', { pane: 'p0' }), S('d', 'right'), { op: 'resize', world: 'main', split: 'p1', sizes: [1, 3] }, { op: 'close', world: 'main', key: 'b' }]],
  ['close the only tab keeps an empty pane', [W('a'), { op: 'close', world: 'main', key: 'a' }]],
  ['close an unknown tab', [W('a'), { op: 'close', world: 'main', key: 'zzz' }]],
  ['swap a tab for another in place', [W('a'), W('b'), { op: 'swap', world: 'main', key: 'a', with: 'c' }]],
  ['swap with a tab open in another pane', [W('a'), S('b', 'right'), { op: 'swap', world: 'main', key: 'a', with: 'b' }]],
  ['swap where with is the key', [W('a'), { op: 'swap', world: 'main', key: 'a', with: 'a' }]],
  ['swap without with', [W('a'), { op: 'swap', world: 'main', key: 'a' }]],
  ['swap of an unknown key', [W('a'), { op: 'swap', world: 'main', key: 'zzz', with: 'a' }]],
  ['move into a pane before a key', [W('a'), S('b', 'right'), { ...W('c'), pane: 'p_0' }, { op: 'move', world: 'main', key: 'c', to: 'p0', before: 'b' }]],
  ['move into a pane appends', [W('a'), S('b', 'right'), { op: 'move', world: 'main', key: 'a', to: 'p0' }]],
  ['move before an unknown key appends', [W('a'), W('b'), S('c', 'right'), { op: 'move', world: 'main', key: 'a', to: 'p0', before: 'nope' }]],
  ['move with a side makes a new pane', [W('a'), W('b'), { op: 'move', world: 'main', key: 'b', to: 'p_0', side: 'down' }]],
  ['move of a pane\'s only tab onto its own pane with a side does nothing', [W('a'), { op: 'move', world: 'main', key: 'a', to: 'p_0', side: 'right' }]],
  ['dropping a tab before itself does nothing', [W('a'), W('b'), { op: 'move', world: 'main', key: 'a', to: 'p_0', before: 'a' }]],
  ['moving the last tab out removes its pane', [W('a'), S('b', 'right'), { op: 'move', world: 'main', key: 'b', to: 'p_0' }]],
  ['move the active tab makes the first tab active', [W('a'), W('b'), W('c'), { op: 'move', world: 'main', key: 'c', to: 'p_0', side: 'right' }]],
  ['move to an unknown pane', [W('a'), { op: 'move', world: 'main', key: 'a', to: 'nope' }]],
  ['split a pane with one tab makes an empty pane', [W('a'), { op: 'split', world: 'main', pane: 'p_0', side: 'down' }]],
  ['split left', [W('a'), { op: 'split', world: 'main', pane: 'p_0', side: 'left' }]],
  ['split of a pane with several tabs moves the active tab', [W('a'), W('b'), { op: 'split', world: 'main', pane: 'p_0', side: 'right' }]],
  ['split an unknown pane', [W('a'), { op: 'split', world: 'main', pane: 'nope', side: 'right' }]],
  ['closePane joins its tabs into the pane before it', [W('a'), S('b', 'right'), { ...W('c'), pane: 'p0' }, { op: 'closePane', world: 'main', pane: 'p0' }]],
  ['closePane of the first pane gives its tabs to the next', [W('a'), S('b', 'right'), { op: 'closePane', world: 'main', pane: 'p_0' }]],
  ['closePane of a lone pane is kept', [W('a'), { op: 'closePane', world: 'main', pane: 'p_0' }]],
  ['closePane of an unknown pane', [W('a'), { op: 'closePane', world: 'main', pane: 'nope' }]],
  ['activate a tab', [W('a'), W('b'), { op: 'activate', world: 'main', pane: 'p_0', key: 'a' }]],
  ['activate a tab the pane lacks', [W('a'), { op: 'activate', world: 'main', pane: 'p_0', key: 'zzz' }]],
  ['focus a pane', [W('a'), S('b', 'right'), { op: 'focus', world: 'main', pane: 'p_0' }]],
  ['focus an unknown pane', [W('a'), { op: 'focus', world: 'main', pane: 'nope' }]],
  ['tabBar on and off', [W('a'), S('b', 'right'), { op: 'tabBar', world: 'main', pane: 'p0', on: true }, { op: 'tabBar', world: 'main', pane: 'p_0', on: false }]],
  ['resize a split', [W('a'), S('b', 'right'), { op: 'resize', world: 'main', split: 'p1', sizes: [0.3, 0.7] }]],
  ['resize with the wrong number of sizes', [W('a'), S('b', 'right'), { op: 'resize', world: 'main', split: 'p1', sizes: [1] }]],
  ['resize an unknown split', [W('a'), S('b', 'right'), { op: 'resize', world: 'main', split: 'zz', sizes: [1, 1] }]],
  ['resize with sizes that are not a list', [W('a'), S('b', 'right'), { op: 'resize', world: 'main', split: 'p1', sizes: 'x' }]],
  ['setRoot focuses the pane with focusKey', [{ op: 'setRoot', world: 'main', root: SETROOT, focusKey: 't2' }]],
  ['setRoot without focusKey focuses the first pane', [{ op: 'setRoot', world: 'main', root: SETROOT }]],
  ['setRoot with an unknown focusKey focuses the first pane', [{ op: 'setRoot', world: 'main', root: SETROOT, focusKey: 'zz' }]],
  ['setRoot with meta sets the tree fields, an empty meta clears them', [{ op: 'current', world: 'a1' }, { op: 'setRoot', world: 'main', root: { id: 'r', tabs: ['agent:a1'], active: 'agent:a1' }, meta: { tree: 'row', mainPane: 'r', treeSig: 'a1()', saved: { id: 'r', tabs: [], active: null } } }, { op: 'setRoot', world: 'main', root: { id: 'r', tabs: [], active: null }, meta: {} }]],
  ['setRoot with a split of no panes', [{ op: 'setRoot', world: 'main', root: { id: 'r', split: 'row', children: [], sizes: [] } }]],
  ['current makes the world with its default view', [{ op: 'current', world: 'a1' }, W('x')]],
  ['current null', [{ op: 'current', world: 'a1' }, { op: 'current', world: null }]],
  ['default worlds: page, thread, ITSA', [{ op: 'open', world: 'w:usage', key: 'config' }, { op: 'open', world: 't:th1', key: 'agent:b' }, { op: 'open', world: 'w:itsa:S-1', key: 'x' }, W('y')]],
  ['a named world of worlds stays there', [{ op: 'open', world: 'side', key: 'x' }], SIDE_WORLD],
  ['main with the current world set to a named world of worlds', [{ op: 'current', world: 'side' }, W('x')], SIDE_WORLD],
  ['drop the current world', [{ op: 'current', world: 'agent-1' }, { op: 'dropWorld', world: 'agent-1' }]],
  ['drop another world', [{ op: 'current', world: 'agent-1' }, { op: 'current', world: 'agent-2' }, { op: 'dropWorld', world: 'agent-1' }]],
  ['unknown op', [{ op: 'nope', world: 'main' }]],
  ['op without a world', [{ op: 'open', key: 'a' }]],
  ['a failed op stops the run', [W('a'), { op: 'close', world: 'main', key: 'zzz' }, W('b')]],
].map(([name, ops, start]) => ({ name, input: start ? { start, ops } : { ops } }));
const runLayoutOps = ({ start, ops }) => {
  let n = 0;
  const made = () => 'p' + n++;
  let layout = start ?? emptyLayout();
  for (const [at, op] of ops.entries()) {
    try {
      layout = apply(layout, op, made);
    } catch (e) {
      return { error: errMessage(e), at };
    }
  }
  return { layout };
};

// --- process-validate: input { yaml, file, knownTypes?, knownStatuses }, output { process?, errors } ------------
const STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'canceled', 'wont_do', 'blocked'];
const MINIMAL = 'process: tiny\ntitle: Tiny\nlanes:\n  human: { type: human }\nnodes:\n  s: { kind: start, lane: human, triggers: [{ source: manual }] }\n  e: { kind: end, lane: human, status: done }\nedges:\n  - [s, e]\n';
const REALISTIC = `process: dev-flow
title: Dev flow
description: A change from request to release.
applies_to: { kind: [issue] }
lanes:
  human: { type: human }
  developer: { type: developer, machine: devbox }
  reviewer: { type: reviewer, fallback: reviewer-opus }
nodes:
  request:
    kind: start
    lane: human
    triggers:
      - { source: github, subjects: ["github:acme/app"], types: [issues.opened] }
      - { source: timer, cron: "0 6 * * *" }
      - { source: slack, example: true }
  code:
    kind: agent
    lane: developer
    label: Implement
    statuses: [in_progress, blocked]
    done_when: pr_opened
    brief: |-
      Open the PR.
    tell: { lanes: [reviewer], text: A PR is coming. }
    boundary: [{ on: cost, action: pause }, { on: timeout, minutes: 90, interrupting: true }]
  review:
    kind: agent
    lane: reviewer
    statuses: [in_review]
  approve:
    kind: human
    lane: human
    ask: approve
  shipped:
    kind: end
    lane: human
    status: done
edges:
  - [request, code]
  - [code, review]
  - [review, approve, { when: approved, label: ok }]
  - [review, code, { label: changes }]
  - [approve, shipped]
`;
const pv = (name, yaml, extra = {}) => ({ name, input: { yaml, file: 'processes/tiny.yaml', knownStatuses: STATUSES, ...extra } });
const DUP = 'processes/tiny.yaml: not valid YAML: Map keys must be unique';
const processValidate = [
  pv('minimal valid process', MINIMAL),
  { name: 'realistic valid process', input: { yaml: REALISTIC, file: 'dev-flow.yaml', knownTypes: ['developer', 'reviewer', 'reviewer-opus', 'manager'], knownStatuses: STATUSES } },
  { ...pv('not valid YAML', 'process: [unclosed'), errorPrefix: 'processes/tiny.yaml: not valid YAML: ' },
  pv('not a mapping', '- a\n- b\n'),
  pv('empty file', ''),
  pv('process id differs from the file name', MINIMAL.replace('process: tiny', 'process: other')),
  pv('process missing', MINIMAL.replace('process: tiny\n', '')),
  pv('lanes missing', 'process: tiny\nnodes: {}\nedges: []\n'),
  pv('nodes and edges missing', 'process: tiny\nlanes:\n  human: { type: human }\n'),
  pv('lane not a mapping', MINIMAL.replace('human: { type: human }', 'human: nope')),
  pv('lane without a type', MINIMAL.replace('human: { type: human }', 'human: { label: x }')),
  pv('unknown lane type', MINIMAL.replace('{ type: human }', '{ type: wizard }'), { knownTypes: ['developer'] }),
  pv('unknown fallback type', MINIMAL.replace('{ type: human }', '{ type: human, fallback: wizard }'), { knownTypes: ['developer'] }),
  pv('lane machine bad', MINIMAL.replace('{ type: human }', '{ type: human, machine: "-bad name" }')),
  pv('lane machine good', MINIMAL.replace('{ type: human }', '{ type: human, machine: laptop.1 }')),
  pv('node id with capitals', MINIMAL.replace('  s: {', '  Start: {').replace('[s, e]', '[Start, e]')),
  pv('node not a mapping', MINIMAL.replace('  e: { kind: end, lane: human, status: done }', '  e: 3')),
  pv('unknown kind', MINIMAL.replace('kind: end', 'kind: gate')),
  pv('node without lane', MINIMAL.replace('kind: end, lane: human', 'kind: end')),
  pv('node with unknown lane', MINIMAL.replace('kind: end, lane: human', 'kind: end, lane: ghost')),
  pv('unknown status', MINIMAL.replace('status: done }', 'status: done, statuses: [limbo] }')),
  pv('status on two nodes', MINIMAL.replace('  s: { kind: start, lane: human,', '  s: { kind: start, lane: human, statuses: [todo],').replace('status: done }', 'status: done, statuses: [todo] }')),
  pv('end without a valid status', MINIMAL.replace('status: done', 'status: todo')),
  pv('human without a valid ask', MINIMAL.replace('  e:', '  h: { kind: human, lane: human, ask: shrug }\n  e:')),
  pv('tell without text', MINIMAL.replace('  e:', '  a: { kind: agent, lane: human, tell: { lanes: [human] } }\n  e:')),
  pv('tell names an unknown lane', MINIMAL.replace('  e:', '  a: { kind: agent, lane: human, tell: { lanes: [ghost], text: hi } }\n  e:')),
  pv('start without a trigger', MINIMAL.replace(' triggers: [{ source: manual }]', '')),
  pv('trigger without a source', MINIMAL.replace('source: manual', 'label: x')),
  pv('timer trigger without a cron', MINIMAL.replace('source: manual', 'source: timer')),
  pv('bad boundary event', MINIMAL.replace('  e:', '  a: { kind: agent, lane: human, boundary: [{ on: weather }] }\n  e:')),
  pv('edge with the wrong shape', MINIMAL.replace('[s, e]', '[s]')),
  pv('edge to an unknown node', MINIMAL.replace('[s, e]', '[s, nowhere]')),
  pv('edge options not a mapping', MINIMAL.replace('[s, e]', '[s, e, nope]')),
  pv('edge into a start node', MINIMAL.replace('  - [s, e]\n', '  - [s, e]\n  - [e, s]\n')),
  pv('edge out of an end node', MINIMAL.replace('  - [s, e]\n', '  - [s, e]\n  - [e, e]\n')),
  pv('errors from two lanes keep the lane order', 'process: tiny\nlanes:\n  a: { label: x }\n  b: { type: wizard }\n  c: nope\nnodes: {}\nedges: []\n', { knownTypes: ['developer'] }),
  pv('errors from two nodes keep the node order', MINIMAL.replace('  e:', '  m: { kind: gate, lane: human }\n  n: { kind: agent }\n  e:')),
  pv('several problems at once', 'process: wrong\nlanes:\n  human: { type: human }\nnodes:\n  s: { kind: start, lane: ghost }\nedges:\n  - [s, x]\n'),
  // (minutes of .inf, .nan and -0 print as null, null and 0 in the API: a JSON fixture can't hold the numbers; yamlvalue_test.go does.)
  // The YAML 1.2 core schema (the `yaml` package's default): what a plain scalar reads as. A node kind shows how it prints.
  ...['2026-10-21', '1_000', '0b11', '0o17', '0x1F', '012', '+5', '1e3', '1.', '.5', '.inf', '-.INF', '.nan', '1e400', 'yes', 'on', 'True', 'tRue', '~', 'null', 'Null', 'NULL', '"7"', "'~'", '!!str 7', '!!int "7"', '[1, 2]', '[a, [b, ~]]', '{ a: 1 }', '0.1e1', '-0', '9007199254740993', '1e21', '1e-7'].map((v) =>
    pv(`a node kind of ${v}`, MINIMAL.replace('kind: end', `kind: ${v}`))),
  ...['0x10', '1_000', '0b1', '1e3', '2026-10-21', '"5"'].map((v) =>
    pv(`boundary minutes of ${v}`, MINIMAL.replace('  e:', `  a: { kind: agent, lane: human, boundary: [{ on: timeout, minutes: ${v} }] }\n  e:`))),
  pv('a date as the title', MINIMAL.replace('title: Tiny', 'title: 2026-10-21')),
  pv('a flag that is not a boolean', MINIMAL.replace('  e:', '  a: { kind: agent, lane: human, boundary: [{ on: timeout, interrupting: yes }] }\n  e:')),
  pv('a flag that is a boolean', MINIMAL.replace('  e:', '  a: { kind: agent, lane: human, boundary: [{ on: timeout, interrupting: TRUE }] }\n  e:')),
  // Keys read as JavaScript property names: the number prints, so 0x10 and 16 and "16" are one key.
  pv('lane keys that are numbers', MINIMAL.replace('human: { type: human }', '1: { type: human }\n  0x10: { type: human }\n  true: { type: human }').replace('lane: human', 'lane: "1"').replace('lane: human', 'lane: "1"')),
  { ...pv('lane keys that are one number', MINIMAL.replace('human: { type: human }', '1: { type: human }\n  0x1: { type: human }')), errorPrefix: DUP },
  { ...pv('lane keys 1 and 1.0', MINIMAL.replace('human: { type: human }', '1: { type: human }\n  1.0: { type: human }')), errorPrefix: DUP },
  pv('a string key and a number key', MINIMAL.replace('human: { type: human }', '"1": { type: human }\n  1: { type: human }')),
  { ...pv('a repeated key', MINIMAL.replace('human: { type: human }', 'human: { type: human }\n  human: { type: human }')), errorPrefix: DUP },
  { ...pv('a repeated key behind an alias', MINIMAL.replace('human: { type: human }', 'human: &h { type: human, type: human }')), errorPrefix: DUP },
  // Anchors and aliases: a value is read where it is used. The 1.2 core schema does not merge `<<`.
  pv('an anchor and an alias', MINIMAL.replace('human: { type: human }', 'human: &h { type: human }\n  other: *h').replace('  e: {', '  e2: &x { kind: end, lane: human, status: canceled }\n  e: {')),
  pv('an alias as a value', MINIMAL.replace('status: done', 'status: *d').replace('title: Tiny', 'title: &d done')),
  pv('a merge key is a key', MINIMAL.replace('  e: { kind: end, lane: human, status: done }', '  base: &b { lane: human }\n  e: { <<: *b, kind: end, status: done }')),
  { ...pv('an alias with no anchor', MINIMAL.replace('title: Tiny', 'title: *nowhere')), errorPrefix: 'processes/tiny.yaml: not valid YAML: ' },
  { ...pv('an anchor read before it is set', MINIMAL.replace('title: Tiny', 'title: *later\ndescription: &later x')), errorPrefix: 'processes/tiny.yaml: not valid YAML: ' },
  pv('an alias that contains itself', MINIMAL.replace('nodes:\n', 'nodes: &n\n  loop: *n\n').replace('  s: {', '  s: {')),
  pv('an alias in its own list', 'process: tiny\nlanes: &l [*l]\nnodes: {}\nedges: []\n'),
  pv('an alias in its own value', 'process: tiny\ndescription: &d [a, *d, b]\nlanes: {}\nnodes: {}\nedges: []\n'),
  pv('an alias bomb', `process: tiny\nx0: &a0 [x, x, x, x, x, x, x, x, x, x]\n${Array.from({ length: 11 }, (_, i) => `x${i + 1}: &a${i + 1} [${Array(10).fill(`*a${i}`).join(', ')}]`).join('\n')}\nlanes: {}\nnodes: {}\nedges: []\n`),
  pv('aliases within the limit', 'process: tiny\nx0: &a0 [x, x]\n' + Array.from({ length: 5 }, (_, i) => `x${i + 1}: [*a0, *a0, *a0, *a0, *a0]`).join('\n') + '\nlanes: {}\nnodes: {}\nedges: []\n'),
  { ...pv('two documents', MINIMAL + '---\n' + MINIMAL), errorPrefix: 'processes/tiny.yaml: not valid YAML: Source contains multiple documents' },
  { ...pv('a second, empty document', MINIMAL + '---\n'), errorPrefix: 'processes/tiny.yaml: not valid YAML: Source contains multiple documents' },
  pv('a document end marker', MINIMAL + '...\n'),
  pv('a document start marker', '---\n' + MINIMAL),
  pv('a null key', MINIMAL.replace('human: { type: human }', '~: { type: human }\n  human: { type: human }')),
  pv('an empty key', MINIMAL.replace('human: { type: human }', '? \n  : { type: human }\n  human: { type: human }')),
  pv('a plain scalar under the ! tag', MINIMAL.replace('kind: end', 'kind: ! 7')),
  pv('a non-specific tag on a number-like key', MINIMAL.replace('human: { type: human }', '! 7: { type: human }').replace(/lane: human/g, 'lane: "7"')),
  { ...pv('an alias that names no anchor in a key', 'process: tiny\n*a : 1\n'), errorPrefix: 'processes/tiny.yaml: not valid YAML: ' },
];
const runProcessValidate = ({ yaml, file, knownTypes, knownStatuses }) =>
  parseProcessText(yaml, { file, knownTypes: knownTypes && new Set(knownTypes), knownStatuses: new Set(knownStatuses) });

// --- tool-name-labels: input { fn, args }, output the function's result (null for undefined) ----------------------
const nl = [];
for (const [harness, tools] of Object.entries(labels.SEEDED)) {
  for (const tool of Object.keys(tools)) nl.push({ name: `seededLabel ${harness} ${tool}`, input: { fn: 'seededLabel', args: [harness, tool] } });
}
nl.push(
  { name: 'seededLabel unknown tool', input: { fn: 'seededLabel', args: ['claude', 'Frobnicate'] } },
  { name: 'seededLabel unknown harness', input: { fn: 'seededLabel', args: ['gemini', 'Bash'] } },
  ...['Bash', 'mcp__stam__send_mail', 'mcp__claude_ai_Gmail__authenticate', 'mcp__a__b__c', 'mcp__nopair', 'stam.send_mail', 'exec_command', ''].flatMap((n) => [
    { name: `splitTool ${n || '(empty)'}`, input: { fn: 'splitTool', args: [n] } },
    { name: `splitTool codex ${n || '(empty)'}`, input: { fn: 'splitTool', args: [n, 'codex'] } },
  ]),
  ...['send_mail', 'WebSearch', 'Bash', 'ABC', 'getHTTPServer', 'a-b_c.d', '__', '', 'x1Y2', 'iOS', 'TodoWrite', 'snake_case_NAME', 'über_tool', 'ÅbcDef'].map((t) => ({ name: `prettyTool ${t || '(empty)'}`, input: { fn: 'prettyTool', args: [t] } })),
  { name: 'toolTitle with a label', input: { fn: 'toolTitle', args: ['Bash', 'Shell'] } },
  { name: 'toolTitle without a label', input: { fn: 'toolTitle', args: ['WebSearch'] } },
  { name: 'toolTitle of an MCP tool', input: { fn: 'toolTitle', args: ['mcp__stam__send_mail'] } },
  { name: 'toolTitle of an MCP tool with a label', input: { fn: 'toolTitle', args: ['mcp__stam__send_mail', 'Send mail now'] } },
  { name: 'toolTitle of a codex MCP tool', input: { fn: 'toolTitle', args: ['stam.send_mail', undefined, 'codex'] } },
  { name: 'toolTitle codex dot stays a built-in for other harnesses', input: { fn: 'toolTitle', args: ['stam.send_mail', undefined, 'claude'] } },
  { name: 'toolTitle empty label falls back', input: { fn: 'toolTitle', args: ['read_file', ''] } },
);
const runLabels = ({ fn, args }) => labels[fn](...args) ?? null;

// --- tool-icons: input { harness?, name }, output the icon name -----------------------------------------------
const icons = [];
for (const [harness, tools] of Object.entries(labels.SEEDED)) {
  for (const tool of Object.keys(tools)) icons.push({ name: `${harness} ${tool}`, input: { harness, name: tool } });
}
icons.push(
  ...[['Bash'], ['exec_command'], ['bash'], ['apply_patch'], ['patch'], ['multiedit'], ['Frobnicate'], ['mcp__stam__send_mail'], ['mcp__github__create_issue'], ['stam.send_mail', 'codex'], ['github.create_issue', 'codex'], ['stam.send_mail', 'claude'], ['', 'claude']]
    .map(([name, harness]) => ({ name: `${harness ?? 'no harness'} ${name || '(empty)'}`, input: harness ? { harness, name } : { name } })),
);
const runIcon = ({ harness, name }) => toolIcon(harness, name);

// --- isSystemNotice: input { from_id?, notice? }, output boolean ---------------------------------------------------
const notice = [
  { name: 'empty mail' }, { name: 'notice 1', notice: 1 }, { name: 'notice 0', notice: 0 }, { name: 'notice true', notice: true },
  { name: 'notice false', notice: false }, { name: 'notice null', notice: null }, { name: 'from a system sender', from_id: 'system:deploy-watch' },
  { name: 'from a system sender, notice 0', from_id: 'system:watch', notice: 0 }, { name: 'from an agent', from_id: 'ay9tn' },
  { name: 'from the human', from_id: 'human' }, { name: 'null sender', from_id: null }, { name: 'from a sender named system', from_id: 'system' },
  { name: 'upper-case System prefix', from_id: 'System:x' }, { name: 'system prefix mid-id', from_id: 'x:system:y' },
  { name: 'agent with a notice', from_id: 'ay9tn', notice: 1 },
].map(({ name, ...input }) => ({ name, input }));
const runNotice = (input) => isSystemNotice(input);

export const FIXTURES = {
  guard: { cases: guard, run: runGuard },
  cron: { cases: cron, run: runCron },
  'stub-embedder': { cases: embedder, run: runEmbedder },
  'layout-ops': { cases: layoutOps, run: runLayoutOps },
  'process-validate': { cases: processValidate, run: runProcessValidate },
  'tool-name-labels': { cases: nl, run: runLabels },
  'tool-icons': { cases: icons, run: runIcon },
  'system-notice': { cases: notice, run: runNotice },
};

// The files' text: a header, then one case per line so a diff shows a changed case on one line.
// What a case's runner gives, with the text after a case's `errorPrefix` cut from each error (an error whose
// wording comes from a library, which a port can't repeat; its prefix is compared).
export function observe(name, c) {
  const out = FIXTURES[name].run(structuredClone(c.input));
  if (c.errorPrefix && out.errors) out.errors = out.errors.map((e) => (e.startsWith(c.errorPrefix) ? c.errorPrefix : e));
  return out;
}

export function render(name) {
  const { cases } = FIXTURES[name];
  const lines = cases.map((c) => '  ' + JSON.stringify({ name: c.name, input: c.input, ...(c.errorPrefix ? { errorPrefix: c.errorPrefix } : {}), output: observe(name, c) }));
  return `{\n"fixture": ${JSON.stringify(name)},\n"cases": [\n${lines.join(',\n')}\n]\n}\n`;
}
