#!/usr/bin/env node
// Unit tests for src/layout-ops.ts (the human's layout as pure data): every op, the tree
// rules (splits nest and merge, closing the last tab removes its pane, moves with a side),
// invalid ops throwing, immutability, and the version step. Deterministic pane ids, no
// daemon, no network. Run with `node --test test/layout-ops.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, deadImageTabOps, defaultWorld, emptyLayout, leaves, validLayout } from '../src/layout-ops.ts';

// Pane ids come from a counter, so each test reads the same ids every run.
function ids() {
  let n = 0;
  return () => 'p' + n++;
}
const run = (ops, start = emptyLayout(), newId = ids()) => ops.reduce((l, op) => apply(l, op, newId), start);
const main = (l) => l.agentWorlds[l.current ?? '_home'];
const tabsOf = (w) => leaves(w.root).map((l) => l.tabs);

test('open in an empty world creates one pane, focuses it, and bumps the version', () => {
  const l = run([{ op: 'open', world: 'main', key: 'a' }]);
  const w = main(l);
  assert.equal(l.version, 1);
  assert.equal(w.root.id, w.focused);
  assert.deepEqual(w.root.tabs, ['a']);
  assert.equal(w.root.active, 'a');
});

test('open appends after the active tab, and background opens leave focus alone', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b' },
    { op: 'open', world: 'main', key: 'c', background: true },
  ]);
  const w = main(l);
  assert.deepEqual(w.root.tabs, ['a', 'b', 'c']);
  // A background open still shows its tab in the pane, as layout.ts does; only focus stays.
  assert.equal(w.root.active, 'c');
  assert.equal(w.focused, w.root.id);
});

test('opening a key that is already open activates it instead of duplicating it', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b' },
    { op: 'open', world: 'main', key: 'a' },
  ]);
  assert.deepEqual(main(l).root.tabs, ['a', 'b']);
  assert.equal(main(l).root.active, 'a');
});

test('open with split puts the tab in a new pane beside the target, on that side', () => {
  const start = run([{ op: 'open', world: 'main', key: 'a' }]);
  const first = main(start).root.id;
  const l = run([{ op: 'open', world: 'main', key: 'b', pane: first, split: 'right' }], start);
  const w = main(l);
  assert.equal(w.root.split, 'row');
  assert.deepEqual(tabsOf(w), [['a'], ['b']]);
  assert.equal(w.focused, w.root.children[1].id);
  assert.deepEqual(w.root.sizes, [1, 1]);
});

test('splitting the same way again adds a sibling to the same split; another direction nests', () => {
  const l1 = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b', split: 'right' },
    { op: 'open', world: 'main', key: 'c', split: 'right' },
  ]);
  assert.deepEqual(tabsOf(main(l1)), [['a'], ['b'], ['c']]);
  assert.equal(main(l1).root.children.length, 3);
  const l2 = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b', split: 'right' },
    { op: 'open', world: 'main', key: 'c', pane: 'p0', split: 'down' },
  ]);
  const w = main(l2);
  assert.equal(w.root.split, 'row');
  assert.equal(w.root.children[1].split, 'col');
  assert.deepEqual(tabsOf(w), [['a'], ['b'], ['c']]);
});

test('split left and up put the new pane before the target', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'split', world: 'main', pane: 'p_0', side: 'left' },
  ]);
  const w = main(l);
  assert.equal(w.root.split, 'row');
  assert.deepEqual(tabsOf(w), [[], ['a']]);
  const u = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'split', world: 'main', pane: 'p_0', side: 'up' },
  ]);
  assert.equal(main(u).root.split, 'col');
  assert.deepEqual(tabsOf(main(u)), [[], ['a']]);
});

test('split of a pane with one tab makes an empty pane beside it and focuses it', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'split', world: 'main', pane: 'p_0', side: 'down' },
  ]);
  const w = main(l);
  assert.equal(w.root.split, 'col');
  assert.equal(w.focused, w.root.children[1].id);
  assert.deepEqual(tabsOf(w), [['a'], []]);
});

test('split of a pane with several tabs moves its active tab into the new pane', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b' },
    { op: 'split', world: 'main', pane: 'p_0', side: 'right' },
  ]);
  assert.deepEqual(tabsOf(main(l)), [['a'], ['b']]);
  assert.equal(main(l).focused, main(l).root.children[1].id);
});

test('closing the last tab of a pane removes the pane and its split gives way to the other child', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b', split: 'right' },
    { op: 'close', world: 'main', key: 'b' },
  ]);
  const w = main(l);
  assert.equal(w.root.split, undefined);
  assert.deepEqual(w.root.tabs, ['a']);
  assert.equal(w.focused, w.root.id);
});

test('closing a tab keeps the next tab active; the sole pane stays even when empty', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b' },
    { op: 'open', world: 'main', key: 'c' },
    { op: 'activate', world: 'main', pane: 'p_0', key: 'b' },
    { op: 'close', world: 'main', key: 'b' },
  ]);
  assert.deepEqual(main(l).root.tabs, ['a', 'c']);
  assert.equal(main(l).root.active, 'c');
  const e = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'close', world: 'main', key: 'a' },
  ]);
  assert.deepEqual(main(e).root.tabs, []);
  assert.equal(main(e).root.active, null);
});

test('closing a split child merges a same-direction child into its parent', () => {
  // row[a, col[b, c]] closing a leaves col[b, c] under a row with nothing else: the col is the root.
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b', split: 'right' },
    { op: 'open', world: 'main', key: 'c', pane: 'p0', split: 'down' },
    { op: 'close', world: 'main', key: 'a' },
  ]);
  const w = main(l);
  assert.equal(w.root.split, 'col');
  assert.deepEqual(tabsOf(w), [['b'], ['c']]);
});

test('move into a pane appends the tab (or inserts before a key) and makes it active', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b', split: 'right' },
    { op: 'open', world: 'main', key: 'c', pane: 'p_0' },
    { op: 'move', world: 'main', key: 'c', to: 'p0', before: 'b' },
  ]);
  const w = main(l);
  assert.deepEqual(tabsOf(w), [['a'], ['c', 'b']]);
  assert.equal(w.root.children[1].active, 'c');
  assert.equal(w.focused, w.root.children[1].id);
});

test('move with a side puts the tab in a new pane beside the target and removes it from its old pane', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b' },
    { op: 'move', world: 'main', key: 'b', to: 'p_0', side: 'down' },
  ]);
  const w = main(l);
  assert.equal(w.root.split, 'col');
  assert.deepEqual(tabsOf(w), [['a'], ['b']]);
  assert.equal(w.focused, w.root.children[1].id);
});

test('a move of a pane\'s only tab onto its own pane with a side does nothing; dropping on its own key does too', () => {
  const start = run([{ op: 'open', world: 'main', key: 'a' }]);
  assert.deepEqual(run([{ op: 'move', world: 'main', key: 'a', to: 'p_0', side: 'right' }], start), { ...start, version: 2 });
  const l = run([{ op: 'open', world: 'main', key: 'a' }, { op: 'open', world: 'main', key: 'b' }]);
  assert.deepEqual(tabsOf(main(run([{ op: 'move', world: 'main', key: 'a', to: 'p_0', before: 'a' }], l))), [['a', 'b']]);
});

test('moving the last tab out of a pane removes that pane', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b', split: 'right' },
    { op: 'move', world: 'main', key: 'b', to: 'p_0' },
  ]);
  assert.equal(main(l).root.split, undefined);
  assert.deepEqual(main(l).root.tabs, ['a', 'b']);
});

test('closePane joins its tabs into the pane before it, and a lone pane is kept', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b', split: 'right' },
    { op: 'open', world: 'main', key: 'c', pane: 'p0' },
    { op: 'closePane', world: 'main', pane: 'p0' },
  ]);
  const w = main(l);
  assert.equal(w.root.split, undefined);
  assert.deepEqual(w.root.tabs, ['a', 'b', 'c']);
  assert.equal(w.focused, w.root.id);
  const lone = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'closePane', world: 'main', pane: 'p_0' },
  ]);
  assert.deepEqual(main(lone).root.tabs, ['a']);
});

test('closePane of the first pane gives its tabs to the pane after it', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b', split: 'right' },
    { op: 'closePane', world: 'main', pane: 'p_0' },
  ]);
  assert.equal(main(l).root.split, undefined);
  assert.deepEqual(main(l).root.tabs, ['b', 'a']);
});

test('activate switches the active tab; focus and tabBar set focus and the tab bar', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b', split: 'right' },
    { op: 'open', world: 'main', key: 'c', pane: 'p_0' },
    { op: 'activate', world: 'main', pane: 'p_0', key: 'a' },
    { op: 'focus', world: 'main', pane: 'p_0' },
    { op: 'tabBar', world: 'main', pane: 'p0', on: true },
  ]);
  const w = main(l);
  assert.equal(w.root.children[0].active, 'a');
  assert.equal(w.focused, 'p_0');
  assert.equal(w.root.children[1].showTabs, true);
});

test('setRoot replaces the tree and focuses the pane with focusKey, else the first pane', () => {
  const root = { id: 'r', split: 'row', children: [{ id: 'x', tabs: ['t1'], active: 't1' }, { id: 'y', tabs: ['t2'], active: 't2' }], sizes: [1, 2] };
  const l = run([{ op: 'setRoot', world: 'main', root, focusKey: 't2' }]);
  assert.equal(main(l).root.id, 'r');
  assert.equal(main(l).focused, 'y');
  const d = run([{ op: 'setRoot', world: 'main', root }]);
  assert.equal(main(d).focused, 'x');
});

test('current selects the main world; other names are agents\' worlds, made with their default view', () => {
  const l = run([
    { op: 'current', world: 'a1' },
    { op: 'open', world: 'main', key: 'x' },
    { op: 'open', world: 'w:usage', key: 'config' },
    { op: 'open', world: 't:th1', key: 'agent:b' },
  ]);
  assert.equal(l.current, 'a1');
  assert.deepEqual(l.agentWorlds.a1.root.tabs, ['agent:a1', 'x']);
  assert.deepEqual(l.agentWorlds['w:usage'].root.tabs, ['usage', 'config']);
  assert.deepEqual(l.agentWorlds['t:th1'].root.tabs, ['thread:th1', 'agent:b']);
  assert.equal(l.agentWorlds._home, undefined);
  assert.deepEqual(l.worlds, {});
});

test('a named world of worlds stays there', () => {
  const start = { ...emptyLayout(), worlds: { side: { root: { id: 's', tabs: [], active: null }, focused: 's' } } };
  const l = run([{ op: 'open', world: 'side', key: 'x' }], start);
  assert.deepEqual(l.worlds.side.root.tabs, ['x']);
  assert.equal(l.agentWorlds.side, undefined);
});

test('the default world of an ITSA holds its view and board, with a fixed pane id', () => {
  assert.deepEqual(defaultWorld('w:itsa:S-1'), { root: { id: 'p_0', tabs: ['itsa:S-1', 'board:S-1'], active: 'itsa:S-1' }, focused: 'p_0' });
  assert.deepEqual(defaultWorld('_home').root.tabs, []);
});

test('ids name the new panes, in order, so two copies agree; made up ones follow', () => {
  const l = run([{ op: 'open', world: 'main', key: 'a' }, { op: 'open', world: 'main', key: 'b', split: 'right', ids: ['mine1', 'mine2'] }]);
  const w = main(l);
  assert.equal(w.root.split, 'row');
  // splitBeside makes the new pane first, then the split around it.
  assert.deepEqual([w.root.children[1].id, w.root.id], ['mine1', 'mine2']);
  assert.equal(w.focused, 'mine1');
  const more = run([{ op: 'split', world: 'main', pane: 'p_0', side: 'down', ids: ['only'] }]);
  assert.equal(main(more).focused, 'only');
  assert.throws(() => apply(l, { op: 'split', world: 'main', pane: 'p_0', side: 'down', ids: ['bad id!'] }), /ids must be/);
});

test('resize sets a split\'s sizes; dropWorld removes a world and leaves it current no more', () => {
  let l = run([{ op: 'current', world: 'a1' }, { op: 'open', world: 'main', key: 'b', split: 'right', ids: ['n', 's'] }]);
  l = apply(l, { op: 'resize', world: 'main', split: 's', sizes: [3, 1] });
  assert.deepEqual(main(l).root.sizes, [3, 1]);
  assert.throws(() => apply(l, { op: 'resize', world: 'main', split: 's', sizes: [1] }), /needs 2 sizes/);
  assert.throws(() => apply(l, { op: 'resize', world: 'main', split: 'zz', sizes: [1, 1] }), /no split zz/);
  assert.deepEqual(apply(emptyLayout(), { op: 'current', world: 't:x' }).agentWorlds['t:x'], defaultWorld('t:x'));
  l = apply(l, { op: 'dropWorld', world: 'a1' });
  assert.equal(l.current, null);
  assert.equal(l.agentWorlds.a1, undefined);
});

test('setRoot with meta sets the tree view\'s fields, and clears them with an empty meta', () => {
  const root = { id: 'r', tabs: ['agent:a1'], active: 'agent:a1' };
  let l = run([{ op: 'current', world: 'a1' }, { op: 'setRoot', world: 'main', root, meta: { tree: 'row', mainPane: 'r', treeSig: 'a1()', saved: root } }]);
  assert.equal(main(l).tree, 'row');
  assert.ok(validLayout(l));
  l = apply(l, { op: 'setRoot', world: 'main', root, meta: {} });
  assert.equal(main(l).tree, undefined);
  assert.equal(main(l).saved, undefined);
});

test('pane ids come from the injected generator, so two runs give the same layout', () => {
  const ops = [{ op: 'open', world: 'main', key: 'a' }, { op: 'open', world: 'main', key: 'b', split: 'right' }];
  assert.deepEqual(run(ops), run(ops));
});

test('invalid ops throw a message naming the problem and change nothing', () => {
  const l = run([{ op: 'open', world: 'main', key: 'a' }]);
  assert.throws(() => apply(l, { op: 'open', world: 'main', key: 'b', pane: 'nope' }), /no pane nope in world main/);
  assert.throws(() => apply(l, { op: 'close', world: 'main', key: 'zzz' }), /no tab zzz in world main/);
  assert.throws(() => apply(l, { op: 'move', world: 'main', key: 'a', to: 'nope' }), /no pane nope/);
  assert.throws(() => apply(l, { op: 'activate', world: 'main', pane: 'p_0', key: 'zzz' }), /no tab zzz/);
  assert.throws(() => apply(l, { op: 'focus', world: 'main', pane: 'nope' }), /no pane nope/);
  assert.throws(() => apply(l, { op: 'split', world: 'main', pane: 'nope', side: 'right' }), /no pane nope/);
  assert.throws(() => apply(l, { op: 'nonsense' }), /unknown layout op/);
  assert.deepEqual(main(l).root.tabs, ['a']);
});

test('apply never mutates its input, for every kind of op', () => {
  const start = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b', split: 'right' },
    { op: 'open', world: 'main', key: 'c', pane: 'p0' },
  ]);
  const frozen = JSON.stringify(start);
  const ops = [
    { op: 'open', world: 'main', key: 'd', pane: 'p_0', split: 'down' },
    { op: 'close', world: 'main', key: 'c' },
    { op: 'move', world: 'main', key: 'a', to: 'p0', side: 'up' },
    { op: 'split', world: 'main', pane: 'p_0', side: 'left' },
    { op: 'closePane', world: 'main', pane: 'p0' },
    { op: 'activate', world: 'main', pane: 'p0', key: 'b' },
    { op: 'focus', world: 'main', pane: 'p_0' },
    { op: 'tabBar', world: 'main', pane: 'p_0', on: false },
    { op: 'setRoot', world: 'main', root: { id: 'r', tabs: [], active: null }, focusKey: undefined },
    { op: 'current', world: 'a9' },
  ];
  for (const op of ops) {
    const out = apply(start, op, ids());
    assert.notEqual(out, start);
    assert.equal(JSON.stringify(start), frozen, `after ${op.op}`);
  }
});

test('every applied op bumps the version by one', () => {
  const l = run([{ op: 'current', world: 'x' }, { op: 'open', world: 'main', key: 'a' }, { op: 'focus', world: 'main', pane: 'p_0' }]);
  assert.equal(l.version, 3);
});

// validLayout: what the daemon accepts into its state and what it reloads at start.
const pane = (id) => ({ id, tabs: [], active: null });
const withRoot = (root) => ({ version: 1, current: null, agentWorlds: {}, worlds: { w: { root, focused: root.id ?? 'x' } } });

test('validLayout accepts the layouts apply produces', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'a' },
    { op: 'open', world: 'main', key: 'b', split: 'right' },
    { op: 'open', world: 'main', key: 'c', pane: 'p0', split: 'down' },
  ]);
  assert.equal(validLayout(l), true);
  assert.equal(validLayout(emptyLayout()), true);
});

test('validLayout refuses a split with no sizes, bad sizes, or all-zero sizes', () => {
  const kids = [pane('x'), pane('y')];
  assert.equal(validLayout(withRoot({ id: 'r', split: 'row', children: kids, sizes: [] })), false, 'empty sizes');
  assert.equal(validLayout(withRoot({ id: 'r', split: 'row', children: kids, sizes: ['bad', 1] })), false, 'a string size');
  assert.equal(validLayout(withRoot({ id: 'r', split: 'row', children: kids, sizes: [0, 0] })), false, 'all-zero sizes');
  assert.equal(validLayout(withRoot({ id: 'r', split: 'row', children: kids, sizes: [-1, 1] })), false, 'a negative size');
  assert.equal(validLayout(withRoot({ id: 'r', split: 'row', children: kids, sizes: [1, Infinity] })), false, 'an infinite size');
  assert.equal(validLayout(withRoot({ id: 'r', split: 'row', children: kids, sizes: [1, 2] })), true, 'good sizes');
});

test('validLayout refuses a split with no children and a pane with bad tabs', () => {
  assert.equal(validLayout(withRoot({ id: 'r', split: 'row', children: [], sizes: [] })), false);
  assert.equal(validLayout(withRoot({ id: 'r', tabs: 'a', active: null })), false);
});

test('setRoot with an invalid tree applies, but the result is not a valid layout', () => {
  const start = run([{ op: 'open', world: 'main', key: 'a' }]);
  const bad = apply(start, { op: 'setRoot', world: 'main', root: { id: 'r', split: 'row', children: [pane('x')], sizes: [] } });
  assert.equal(validLayout(bad), false);
});

test('swap shows a tab in place of another, in the same pane and place', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'agent:x' },
    { op: 'open', world: 'main', key: 'mail:x' },
    { op: 'activate', world: 'main', pane: 'p_0', key: 'agent:x' },
    { op: 'swap', world: 'main', key: 'agent:x', with: 'view:x' },
  ]);
  assert.deepEqual(main(l).root.tabs, ['view:x', 'mail:x']);
  assert.equal(main(l).root.active, 'view:x');
  // A swap of a tab in the background leaves the active one alone.
  const b = run([{ op: 'activate', world: 'main', pane: 'p_0', key: 'mail:x' }, { op: 'swap', world: 'main', key: 'view:x', with: 'agent:x' }], l);
  assert.deepEqual(main(b).root.tabs, ['agent:x', 'mail:x']);
  assert.equal(main(b).root.active, 'mail:x');
});

test('swap moves a with open elsewhere in the world, so it never shows twice', () => {
  const l = run([
    { op: 'open', world: 'main', key: 'agent:x' },
    { op: 'open', world: 'main', key: 'view:x', split: 'right' },
    { op: 'swap', world: 'main', key: 'agent:x', with: 'view:x' },
  ]);
  assert.equal(main(l).root.split, undefined);
  assert.deepEqual(main(l).root.tabs, ['view:x']);
  assert.throws(() => apply(l, { op: 'swap', world: 'main', key: 'agent:zzz', with: 'view:zzz' }), /no tab agent:zzz/);
  assert.throws(() => apply(l, { op: 'swap', world: 'main', key: 'view:x' }), /swap needs a tab key/);
});

// S-1475: an `image:PAGE.N` tab belongs to the page that opened it. The daemon closes the ones whose page
// isn't live, on any device, and leaves every other tab and pane alone.
test('deadImageTabOps closes the image tabs of dead pages only, and a pane left empty closes', () => {
  const l = {
    version: 1,
    current: 'a1',
    agentWorlds: {
      a1: {
        root: { id: 's', split: 'row', sizes: [1, 1], children: [
          { id: 'p1', tabs: ['agent:a1', 'image:live1.1', 'image:dead1.1'], active: 'image:dead1.1' },
          { id: 'p2', tabs: ['image:dead2.4'], active: 'image:dead2.4' },
        ] },
        focused: 'p1',
      },
    },
    worlds: {},
  };
  const ops = deadImageTabOps(l, (page) => page === 'live1');
  assert.deepEqual(ops, [
    { op: 'close', world: 'a1', key: 'image:dead1.1' },
    { op: 'close', world: 'a1', key: 'image:dead2.4' },
  ]);
  const after = ops.reduce((x, op) => apply(x, op), l);
  assert.ok(validLayout(after));
  assert.deepEqual(tabsOf(main(after)), [['agent:a1', 'image:live1.1']]);
  assert.deepEqual(leaves(main(after).root).map((x) => x.id), ['p1']);
  assert.deepEqual(deadImageTabOps(after, (page) => page === 'live1'), []);
});

test('deadImageTabOps reads the named worlds too, and nothing when every page is live', () => {
  const l = {
    version: 1,
    current: null,
    agentWorlds: {},
    worlds: { files: { root: { id: 'p9', tabs: ['image:gone.9', 'files'], active: 'image:gone.9' }, focused: 'p9' } },
  };
  const ops = deadImageTabOps(l, () => false);
  assert.deepEqual(ops, [{ op: 'close', world: 'files', key: 'image:gone.9' }]);
  const after = apply(l, ops[0]);
  assert.ok(validLayout(after));
  assert.deepEqual(tabsOf(after.worlds.files), [['files']]);
  assert.deepEqual(deadImageTabOps(l, () => true), []);
});
