#!/usr/bin/env node
// The story check (S-648, scripts/story-check.mjs): a new component without a story fails, a broken
// code link fails, a changed component with unchanged stories fails and passes with a
// `Stories: unchanged, REASON` line, and a code list passed positionally counts as one (S-824). The
// last test runs the CLI over a throwaway git repo.
// Run with `node --test test/story-check.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmphome.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const SCRIPT = join(ROOT, 'scripts/story-check.mjs');
const { checkRange, checkStories, codeLinks, exportedComponents, isMotionFile, motionExempt, pendingList, storiesUnchanged, storiesUnchangedLine } = await import(SCRIPT);

const TREE = 'export function Tree() { return null }\n';
const story = (...codes) => `export const stories = [{ code: [${codes.map((c) => `'${c}'`).join(', ')}] }]\n`;
const base = () => ({ files: { 'web/src/Tree.tsx': TREE, 'web/src/Tree.stories.tsx': story('web/src/Tree.tsx#Tree') }, changed: [], body: '' });
const run = (o) => checkStories({ ...base(), ...o });

test('a new component with no story fails, naming the file, the component and the fix', () => {
  const files = { ...base().files, 'web/src/Pane.tsx': 'export const Pane = () => null\n' };
  const errors = run({ files, changed: ['web/src/Pane.tsx'] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /web\/src\/Pane\.tsx: the component Pane has no story/);
  assert.match(errors[0], /web\/src\/Pane#Pane|web\/src\/Pane\.tsx#Pane/);
  assert.match(errors[0], /Pane\.stories\.tsx/);
});

test("a path#Symbol in a story's prose does not count as a code link (S-685)", () => {
  // The `when` names the file; only a code list links a component to a story.
  const prose = "export const stories = [{ name: 'Other', what: 'Shows the tree.', when: 'Beside `web/src/Pane.tsx#Pane`.', code: ['web/src/Tree.tsx#Tree'], rules: [] }]\n";
  const files = { ...base().files, 'web/src/Pane.tsx': 'export const Pane = () => null\n', 'web/src/Other.stories.tsx': prose };
  assert.deepEqual(codeLinks(prose), [{ file: 'web/src/Tree.tsx', symbol: 'Tree' }]);
  assert.match(run({ files, changed: ['web/src/Pane.tsx'] })[0], /web\/src\/Pane\.tsx: the component Pane has no story/);
});

test('a code list passed positionally counts too (S-824)', () => {
  // mailblocks.stories.tsx builds its stories through `block(name, what, when, code, rules, states)`,
  // so `web/src/mail/Rendered.tsx#Rendered` is never a `code:` property but still a code link.
  const positional = (code) => `const block = (name, what, when, code, rules, states) => ({ name, code })\nexport const stories = [block('Decision', 'What it is.', 'When it shows.', [${code.map((c) => `'${c}'`).join(', ')}], ['A rule of prose.'], [])]\n`;
  assert.deepEqual(codeLinks(positional(['decision', 'markDecisions', 'web/src/Rendered.tsx#Rendered'])), [{ file: 'web/src/Rendered.tsx', symbol: 'Rendered' }]);
  // A list of sentences is prose, even when one names a path: it claims nothing.
  const rules = "export const stories = [{ code: ['web/src/Tree.tsx#Tree'], rules: ['See `web/src/Pane.tsx#Pane` for the rest of it.'] }]\n";
  assert.deepEqual(codeLinks(rules), [{ file: 'web/src/Tree.tsx', symbol: 'Tree' }]);
  // The component the positional list names is covered, so the check passes.
  const files = { ...base().files, 'web/src/Pane.tsx': 'export const Pane = () => null\n', 'web/src/Pane.stories.tsx': positional(['web/src/Pane.tsx#Pane']) };
  assert.deepEqual(run({ files, changed: ['web/src/Pane.tsx', 'web/src/Pane.stories.tsx'] }), []);
  assert.match(run({ files, changed: ['web/src/Pane.tsx'] })[0], /web\/src\/Pane\.tsx changed but its stories/);
});

test('a bracketed path#Symbol in prose is not a code list (S-824 review)', () => {
  // The brackets sit inside a string: reading them as an array would let `code: []` claim Pane,
  // so an unstoried component would pass.
  const prose = "export const stories = [{ name: 'Other', what: 'See [`web/src/Pane.tsx#Pane`] beside the tree.', code: [], rules: [] }]\n";
  assert.deepEqual(codeLinks(prose), []);
  const files = { ...base().files, 'web/src/Pane.tsx': 'export const Pane = () => null\n', 'web/src/Other.stories.tsx': prose };
  assert.match(run({ files, changed: ['web/src/Pane.tsx'] })[0], /web\/src\/Pane\.tsx: the component Pane has no story/);
});

test('a commented-out code list is not one either (S-824 review)', () => {
  const commented = "// export const stories = [{ code: ['web/src/Pane.tsx#Pane'] }]\nexport const stories = [{ code: [] }]\n";
  assert.deepEqual(codeLinks(commented), []);
});

test("a variable beside a code list's strings keeps the list", () => {
  const mixed = "const ALL = []\nexport const stories = [{ code: [ALL, 'web/src/Tree.tsx#Tree'] }]\n";
  assert.deepEqual(codeLinks(mixed), [{ file: 'web/src/Tree.tsx', symbol: 'Tree' }]);
});

test('a broken code link fails for any story, changed or not: missing file, missing symbol', () => {
  const files = { ...base().files, 'web/src/Bad.stories.tsx': story('web/src/Nope.tsx#Nope', 'web/src/Tree.tsx#Missing') };
  const errors = run({ files });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Bad\.stories\.tsx: .*Nope\.tsx#Nope names a file that doesn't exist/);
  assert.match(errors[1], /Tree\.tsx#Missing names a symbol web\/src\/Tree\.tsx doesn't declare/);
});

test('a changed component whose stories did not change fails; changing the stories, or a Stories: unchanged line, passes', () => {
  const changed = ['web/src/Tree.tsx'];
  assert.match(run({ changed })[0], /web\/src\/Tree\.tsx changed but its stories \(web\/src\/Tree\.stories\.tsx\) didn't/);
  assert.deepEqual(run({ changed: [...changed, 'web/src/Tree.stories.tsx'] }), []);
  assert.deepEqual(run({ changed, body: 'ITSA: S-1\nGates: none\nDeploy: normal\n\nStories: unchanged, a refactor with no visible change' }), []);
  assert.equal(run({ changed, body: 'Stories: unchanged' }).length, 1, 'a reason is required');
});

test('stories, tests and web/src/stories are never components; ALL_CAPS and types do not count', () => {
  const files = {
    ...base().files,
    'web/src/Tree.test.tsx': 'export function Helper() {}\n',
    'web/src/stories/Viewer.tsx': 'export function Viewer() {}\n',
    'web/src/Other.stories.tsx': `export function Frame() {}\n${story('web/src/Tree.tsx#Tree')}`,
    'web/src/consts.tsx': 'export const GROUPS = []\nexport type Thing = {}\nexport function useThing() {}\n',
  };
  const changed = ['web/src/Tree.test.tsx', 'web/src/stories/Viewer.tsx', 'web/src/Other.stories.tsx', 'web/src/consts.tsx'];
  assert.deepEqual(run({ files, changed }), []);
  assert.deepEqual(exportedComponents('export default function App() {}\nexport const Row = memo(() => null)\nexport class Box {}\nconst Local = 1\n'), ['App', 'Row', 'Box']);
  assert.equal(storiesUnchanged('Stories: unchanged, why'), true);
});

test('a context export is not a component', () => {
  assert.deepEqual(exportedComponents('export const TimingContext = createContext<number>(0)\nexport const Other = React.createContext(null)\nexport const Real = () => null\n'), ['Real']);
});

test('Stories: unchanged takes a comma, colon, period, semicolon, dash, or `for` before its reason (S-914)', () => {
  for (const line of [
    'Stories: unchanged, a refactor with no visible change',
    'Stories: unchanged: a refactor',
    'Stories: unchanged. a refactor',
    'Stories: unchanged; a refactor',
    'Stories: unchanged — a refactor',
    'Stories: unchanged - a refactor',
    'Stories: unchanged for X, Y',
    'Stories: unchanged for the menu only',
    'Stories:unchanged,a refactor',
    '- Stories: unchanged: a refactor',
  ]) assert.equal(storiesUnchanged(line), true, line);
});

test('Stories: unchanged without a reason, or with unchanged not first, is refused (S-914)', () => {
  for (const line of [
    'Stories: unchanged',
    'Stories: unchanged,',
    'Stories: unchanged:   ',
    'Stories: unchanged.',
    'Stories: unchanged for',
    'Stories: unchanged for ',
    'Stories: unchanged forever, reason',
    'Stories: unchangedish, reason',
    'Stories: mostly unchanged, reason',
    'Stories: changed, unchanged, reason',
    'Stories: changed, not unchanged',
    'Stories: unchanged-ish, reason',
    'Stories: unchanged.md is fine',
    'Stories: unchanged, ,',
    'Stories: unchanged, .',
    'Stories: unchanged—,x',
  ]) assert.equal(storiesUnchanged(line), false, line);
  assert.equal(storiesUnchanged('Stories: unchanged\nStories: unchanged, a refactor'), false, 'the first Stories: unchanged line decides');
  assert.equal(storiesUnchanged(''), false);
  assert.equal(storiesUnchanged(undefined), false);
});

test('storiesUnchangedLine finds the first Stories: unchanged line, a bullet included', () => {
  assert.equal(storiesUnchangedLine('ITSA: S-1\n- Stories: unchanged for X'), 'Stories: unchanged for X');
  assert.equal(storiesUnchangedLine('ITSA: S-1\nStories: mostly changed'), undefined);
});

test('Stories: unchanged also counts as a bullet', () => {
  assert.equal(storiesUnchanged('- Stories: unchanged, a refactor'), true);
  assert.equal(storiesUnchanged('* Stories: unchanged, a refactor'), true);
  assert.equal(storiesUnchanged('- Stories: unchanged'), false);
});

test('the CLI reads a git range and the PR body from STORY_CHECK_BODY', () => {
  const dir = tempDir('stam-story-check-');
  try {
    const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' }).trim();
    const put = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
    git('init', '-q');
    // The CLI checks the repo its own script sits in (S-1300), so the throwaway repo gets a copy.
    put('scripts/story-check.mjs', readFileSync(SCRIPT, 'utf8'));
    put('web/src/Tree.tsx', TREE);
    put('web/src/Tree.stories.tsx', story('web/src/Tree.tsx#Tree'));
    git('add', '-A'); git('commit', '-qm', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    const cli = (sha, body = '') => spawnSync('node', [join(dir, 'scripts/story-check.mjs'), baseSha, sha], { cwd: dir, encoding: 'utf8', env: { ...process.env, STORY_CHECK_BODY: body } });
    assert.equal(cli(baseSha).status, 0);
    put('web/src/Tree.tsx', `${TREE}// edit\n`);
    git('add', '-A'); git('commit', '-qm', 'component only');
    const head = git('rev-parse', 'HEAD');
    const bad = cli(head);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /web\/src\/Tree\.tsx changed but its stories/);
    assert.equal(cli(head, 'Stories: unchanged, comment only').status, 0);
    // A new component with no story fails, unless the PR says why its stories didn't change.
    put('web/src/Pane.tsx', 'export const Pane = () => null\n');
    git('add', '-A'); git('commit', '-qm', 'new component');
    assert.match(cli(git('rev-parse', 'HEAD'), 'Stories: unchanged, x').stderr, /the component Pane has no story/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the audit names every component with no story (S-1096), positional code lists included (S-824)', () => {
  const dir = tempDir('stam-story-pending-');
  try {
    const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' }).trim();
    const put = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
    git('init', '-q');
    put('web/src/Tree.tsx', TREE);
    put('web/src/Tree.stories.tsx', story('web/src/Tree.tsx#Tree'));
    // The mailblocks.stories.tsx shape: the code list is an argument, never a `code:` property.
    put('web/src/mail/Rendered.tsx', 'export function Rendered() { return null }\n');
    put('web/src/mail/mailblocks.stories.tsx', `const block = (name, when, code, states) => ({ name, code, states })
export const stories = [block('Decision', 'In a mail.', ['decision', 'markDecisions', 'web/src/mail/Rendered.tsx#Rendered'], [])]
`);
    put('web/src/Pane.tsx', 'export const Pane = () => null\n');
    git('add', '-A'); git('commit', '-qm', 'tree');
    assert.deepEqual(pendingList(dir), ['web/src/Pane.tsx']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkStories modes split the per-PR exemption from the global checks (S-830)', () => {
  const changed = ['web/src/Tree.tsx'];
  // Full: a changed component whose story did not change needs its own exemption (rule 3).
  assert.match(run({ changed })[0], /Stories: unchanged, REASON/);
  // Exempt keeps only rule 3; structural keeps only the global checks (rules 1 and 2).
  assert.match(run({ changed, mode: 'exempt' })[0], /Stories: unchanged, REASON/);
  assert.deepEqual(run({ changed, mode: 'exempt', body: 'Stories: unchanged, a refactor\n' }), []);
  assert.deepEqual(run({ changed, mode: 'structural' }), [], 'structural ignores the exemption rule');
  // ...but structural still catches a link that does not resolve on the tree it runs on.
  const broken = { ...base().files, 'web/src/Tree.stories.tsx': story('web/src/Tree.tsx#Gone') };
  assert.match(run({ files: broken, changed, mode: 'structural' })[0], /Tree\.tsx#Gone/);
  assert.deepEqual(run({ files: broken, changed, mode: 'exempt', body: 'Stories: unchanged, a refactor\n' }), []);
});

test("the CLI checks the script's own repo, not the cwd's (S-1300)", () => {
  // The cwd is another repo whose only component has no story. Run from it, the CLI must still check
  // ROOT: the range is ROOT's HEAD, so it passes, and it doesn't fail on the other repo's component.
  const other = tempDir('stam-story-cwd-');
  try {
    const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: other, encoding: 'utf8' }).trim();
    const put = (p, s) => { mkdirSync(dirname(join(other, p)), { recursive: true }); writeFileSync(join(other, p), s); };
    git('init', '-q');
    put('web/src/Pane.tsx', 'export const Pane = () => null\n');
    git('add', '-A'); git('commit', '-qm', 'component with no story');
    const own = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const r = spawnSync('node', [SCRIPT, own, own], { cwd: other, encoding: 'utf8', env: { ...process.env, STORY_CHECK_BODY: '' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'story-check: ok');
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

// The motion check (S-1281): a motion file changed needs a web/check/*.mjs browser check in the PR, or the
// PR body's `Motion check: none, REASON`. The motion files here are .ts, so the component rule doesn't apply.
const MOTION_ERR = /motion files changed \(web\/src\/system\/flights\.ts\) with no web\/check\/\*\.mjs browser check; add one or put "Motion check: none, REASON" in the PR body/;
const MOTION = ['web/src/system/flights.ts'];
test('a motion change with no browser check is refused, naming the files and the exemption form (S-1281)', () => {
  assert.match(run({ changed: MOTION })[0], MOTION_ERR);
  assert.match(run({ changed: ['web/src/row-flip.ts'] })[0], /motion files changed \(web\/src\/row-flip\.ts\)/);
});

test('a motion change with a web/check/*.mjs browser check passes (S-1281)', () => {
  assert.deepEqual(run({ changed: [...MOTION, 'web/check/phone.mjs'] }), []);
  // A check must be a .mjs directly in web/check; a file elsewhere does not count.
  assert.match(run({ changed: [...MOTION, 'web/check/notes.txt'] })[0], MOTION_ERR);
  assert.match(run({ changed: [...MOTION, 'web/check/sub/x.mjs'] })[0], MOTION_ERR);
});

test('a motion change with a Motion check: none, REASON line passes (S-1281)', () => {
  assert.deepEqual(run({ changed: MOTION, body: 'ITSA: S-1\n\nMotion check: none, a refactor with no visible motion' }), []);
  assert.deepEqual(run({ changed: MOTION, body: '- Motion check: none, a refactor' }), [], 'a bullet counts');
  assert.equal(motionExempt('Motion check: none, a refactor'), true);
});

test('a malformed Motion check exemption is refused (S-1281)', () => {
  for (const body of ['Motion check: none', 'Motion check: none,', 'Motion check: none, ,', 'Motion check: none.', 'Motion check: maybe, a reason', '']) {
    assert.equal(motionExempt(body), false, body);
    assert.match(run({ changed: MOTION, body })[0], MOTION_ERR, body);
  }
});

test('a test or story file under web/src/system is not a motion file (S-1281)', () => {
  assert.equal(isMotionFile('web/src/system/flights.test.ts'), false);
  assert.equal(isMotionFile('web/src/system/Roll.stories.tsx'), false);
  assert.equal(isMotionFile('web/src/system/flights.ts'), true);
  assert.equal(isMotionFile('web/src/system/system.css'), true);
  assert.equal(isMotionFile('web/src/sidebar-flip.tsx'), true);
  assert.equal(isMotionFile('web/src/useMotion.ts'), true);
  assert.equal(isMotionFile('web/src/Tree.tsx'), false);
  assert.deepEqual(run({ changed: ['web/src/system/flights.test.ts', 'web/src/system/Roll.stories.tsx'] }), []);
});

test('structural mode skips the motion check (S-1281)', () => {
  assert.deepEqual(run({ changed: MOTION, mode: 'structural' }), []);
  assert.match(run({ changed: MOTION, mode: 'exempt' })[0], MOTION_ERR, 'the per-PR gate run checks it');
});

test('a deletion-only change to motion files passes (S-1281)', () => {
  const dir = tempDir('stam-motion-delete-');
  try {
    const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' }).trim();
    const put = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
    git('init', '-q');
    put('web/src/system/flights.ts', 'export const x = 1\n');
    put('web/src/system/flights.test.ts', 'export const y = 1\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const baseSha = git('rev-parse', 'HEAD');
    git('rm', '-q', 'web/src/system/flights.ts');
    git('commit', '-qm', 'delete motion file');
    const head = git('rev-parse', 'HEAD');
    assert.deepEqual(checkRange(baseSha, head, { cwd: dir, body: '' }), []);
    // The same file added or changed is refused.
    put('web/src/system/flights.ts', 'export const x = 2\n');
    git('add', '-A'); git('commit', '-qm', 'change motion file');
    assert.match(checkRange(head, git('rev-parse', 'HEAD'), { cwd: dir, body: '' })[0], MOTION_ERR);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
