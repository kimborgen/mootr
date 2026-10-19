// The human's layout: worlds, panes, and tabs, as pure data. Stam's daemon keeps one Layout
// (src/layout.ts) and the web shell reads it; both apply the same LayoutOps through `apply`.
// No imports at all, so this module runs in node and in the browser. Ported from the shell's
// tree logic (web/src/shell/layout.ts) without its DOM, views, or view gc.
// `world` is 'main' (the current world: where an agent last sent the human, or the home
// world when none is; each device navigates on its own) or a world's name.

export type Dir = 'row' | 'col';
export type Side = 'right' | 'left' | 'down' | 'up';
export interface Leaf { id: string; tabs: string[]; active: string | null; showTabs?: boolean; split?: undefined }
export interface Split { id: string; split: Dir; children: Node[]; sizes: number[] }
export type Node = Leaf | Split;
export interface World {
  root: Node;
  focused: string;
  // The tree view (app code): its direction, the layout it replaced, the agent's own pane.
  tree?: Dir;
  saved?: Node;
  mainPane?: string;
  treeSig?: string;
}
export interface Layout {
  version: number;
  current: string | null;
  agentWorlds: Record<string, World>;
  worlds: Record<string, World>;
}

// The tree view's fields of a world (app code), which setRoot can set along with the root.
export type TreeMeta = Pick<World, 'tree' | 'saved' | 'mainPane' | 'treeSig'>;

// `ids`, on any op, names the ids its new panes and splits get, in the order it makes them
// (more are made up when they run out). The web picks them when it applies an op itself
// before the daemon does, so both copies end with the same pane ids.
export type LayoutOp = (
  | { op: 'open'; world: string; key: string; pane?: string; split?: Side; background?: boolean }
  | { op: 'close'; world: string; key: string }
  | { op: 'swap'; world: string; key: string; with: string }
  | { op: 'move'; world: string; key: string; to: string; before?: string | null; side?: Side }
  | { op: 'split'; world: string; pane: string; side: Side }
  | { op: 'closePane'; world: string; pane: string }
  | { op: 'activate'; world: string; pane: string; key: string }
  | { op: 'focus'; world: string; pane: string }
  | { op: 'tabBar'; world: string; pane: string; on: boolean }
  | { op: 'resize'; world: string; split: string; sizes: number[] }
  | { op: 'setRoot'; world: string; root: Node; focusKey?: string; meta?: TreeMeta }
  | { op: 'dropWorld'; world: string }
  | { op: 'current'; world: string | null }
) & { ids?: string[] };

export const HOME = '_home';

export type NewId = () => string;
export const defaultId: NewId = () => 'p' + Math.random().toString(36).slice(2, 10);

export const emptyLayout = (): Layout => ({ version: 0, current: null, agentWorlds: {}, worlds: {} });
export const isEmptyLayout = (l: Layout) => l.current === null && !Object.keys(l.agentWorlds).length && !Object.keys(l.worlds).length;

// A world's layout before anything changes it: one pane with the world's own view (an
// agent's terminal, a thread, Settings, Usage; an ITSA's view and its board). Its pane id is
// fixed, so every copy of the layout makes the same world.
export function defaultWorld(id: string): World {
  const tabs = id === HOME ? [] : id.startsWith('w:itsa:') ? ['itsa:' + id.slice(7), 'board:' + id.slice(7)] : id.startsWith('t:') ? ['thread:' + id.slice(2)] : id.startsWith('w:') ? [id.slice(2)] : ['agent:' + id];
  const root: Leaf = { id: 'p_0', tabs, active: tabs[0] ?? null };
  return { root, focused: root.id };
}

// Whether a value has the Layout shape and every tree in it is well formed: panes have tabs and
// an active tab or null; splits have children and one positive, finite size per child.
function validNode(n: any): boolean {
  if (!n || typeof n !== 'object') return false;
  if (n.split === undefined) return typeof n.id === 'string' && Array.isArray(n.tabs) && n.tabs.every((t: unknown) => typeof t === 'string') && (n.active === null || typeof n.active === 'string');
  return (n.split === 'row' || n.split === 'col') && typeof n.id === 'string' && Array.isArray(n.children) && n.children.length > 0 && Array.isArray(n.sizes) && n.sizes.length === n.children.length && n.sizes.every((x: unknown) => typeof x === 'number' && Number.isFinite(x) && x > 0) && n.children.every(validNode);
}
function validWorld(w: any): w is World {
  return !!w && typeof w === 'object' && validNode(w.root) && typeof w.focused === 'string' && (w.saved === undefined || validNode(w.saved));
}
export function validLayout(l: any): l is Layout {
  if (!l || typeof l !== 'object' || !Number.isInteger(l.version) || l.version < 0) return false;
  if (l.current !== null && typeof l.current !== 'string') return false;
  for (const map of [l.agentWorlds, l.worlds]) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
    if (!Object.values(map).every(validWorld)) return false;
  }
  return true;
}

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export function leaves(n: Node): Leaf[] {
  return n.split ? n.children.flatMap(leaves) : [n];
}
function parentOf(root: Node, node: Node): { parent: Split; index: number } | null {
  if (!root.split) return null;
  for (const [i, c] of root.children.entries()) {
    if (c === node) return { parent: root, index: i };
    const r = parentOf(c, node);
    if (r) return r;
  }
  return null;
}
function replace(w: World, node: Node, withNode: Node) {
  const p = parentOf(w.root, node);
  if (p) p.parent.children[p.index] = withNode;
  else w.root = withNode;
}
// Puts `fresh` beside `target`, on the side `side` names.
function splitBeside(w: World, target: Node, fresh: Node, side: Side, newId: NewId) {
  const dir: Dir = side === 'right' || side === 'left' ? 'row' : 'col';
  const before = side === 'left' || side === 'up';
  const p = parentOf(w.root, target);
  if (p && p.parent.split === dir) {
    const s = p.parent.sizes[p.index] / 2;
    p.parent.sizes[p.index] = s;
    p.parent.children.splice(p.index + (before ? 0 : 1), 0, fresh);
    p.parent.sizes.splice(p.index + (before ? 0 : 1), 0, s);
  } else {
    replace(w, target, { id: newId(), split: dir, children: before ? [fresh, target] : [target, fresh], sizes: [1, 1] });
  }
}
// Removes an empty pane; a split left with one child gives way to it.
function removeLeaf(w: World, target: Leaf) {
  const p = parentOf(w.root, target);
  if (!p) return;
  p.parent.children.splice(p.index, 1);
  p.parent.sizes.splice(p.index, 1);
  if (p.parent.children.length === 1) {
    const only = p.parent.children[0];
    const gp = parentOf(w.root, p.parent);
    // A child split in the same direction as its new parent merges into it.
    if (gp && only.split && only.split === gp.parent.split) {
      const s = gp.parent.sizes[gp.index];
      const total = only.sizes.reduce((a, b) => a + b, 0);
      gp.parent.children.splice(gp.index, 1, ...only.children);
      gp.parent.sizes.splice(gp.index, 1, ...only.sizes.map((x) => (x / total) * s));
    } else replace(w, p.parent, only);
  }
  if (w.focused === target.id) w.focused = leaves(w.root)[0].id;
}

// The world an op names: 'main' is the current one's; any other name is a world of
// `worlds` when it has one, else an agent's, thread's, or page's world. A world that doesn't
// exist yet starts as defaultWorld.
function worldOf(l: Layout, world: string): World {
  if (world !== 'main' && l.worlds[world]) return l.worlds[world];
  const id = world === 'main' ? (l.current ?? HOME) : world;
  return (l.agentWorlds[id] ??= defaultWorld(id));
}
// The ids an op names first, then made up ones.
function idsFrom(op: LayoutOp, newId: NewId): NewId {
  if (op.ids === undefined) return newId;
  if (!Array.isArray(op.ids) || !op.ids.every((x) => typeof x === 'string' && /^[\w:.-]{1,64}$/.test(x))) throw new Error('ids must be a list of pane ids (letters, digits, _ : . -)');
  const q = [...op.ids];
  return () => q.shift() ?? newId();
}
function findSplit(n: Node, id: string): Split | undefined {
  if (!n.split) return undefined;
  if (n.id === id) return n;
  for (const c of n.children) {
    const s = findSplit(c, id);
    if (s) return s;
  }
  return undefined;
}
function leafIn(w: World, id: string, world: string): Leaf {
  const l = leaves(w.root).find((x) => x.id === id);
  if (!l) throw new Error(`no pane ${id} in world ${world}`);
  return l;
}
function tabIn(w: World, key: string, world: string): { leaf: Leaf; index: number } {
  for (const leaf of leaves(w.root)) {
    const index = leaf.tabs.indexOf(key);
    if (index >= 0) return { leaf, index };
  }
  throw new Error(`no tab ${key} in world ${world}`);
}
function focusedLeaf(w: World): Leaf {
  return leaves(w.root).find((l) => l.id === w.focused) ?? leaves(w.root)[0];
}

function doMove(w: World, world: string, key: string, toId: string, beforeKey: string | null | undefined, side: Side | undefined, newId: NewId) {
  const f = tabIn(w, key, world);
  const target = leafIn(w, toId, world);
  if (side && f.leaf === target && f.leaf.tabs.length === 1) return;
  if (beforeKey === key) return; // dropped on its own place
  f.leaf.tabs.splice(f.index, 1);
  if (f.leaf.active === key) f.leaf.active = f.leaf.tabs[0] ?? null;
  let dest: Leaf = target;
  if (side) {
    dest = { id: newId(), tabs: [key], active: key };
    splitBeside(w, target, dest, side, newId);
  } else {
    const at = beforeKey ? target.tabs.indexOf(beforeKey) : -1;
    if (at >= 0) target.tabs.splice(at, 0, key);
    else target.tabs.push(key);
    target.active = key;
  }
  if (!f.leaf.tabs.length) removeLeaf(w, f.leaf);
  w.focused = dest.id;
}

const OPS = new Set(['open', 'close', 'swap', 'move', 'split', 'closePane', 'activate', 'focus', 'tabBar', 'resize', 'setRoot', 'dropWorld', 'current']);

// Applies one op and returns the new layout (the input is never mutated). The version goes
// up by one. Throws an Error naming the problem for an unknown pane, tab, or side it can't use.
export function apply(layout: Layout, op: LayoutOp, made: NewId = defaultId): Layout {
  if (!OPS.has(op?.op)) throw new Error(`unknown layout op ${(op as { op?: string })?.op}`);
  if (op.op !== 'current' && typeof op.world !== 'string') throw new Error(`${op.op} needs a world`);
  const l = copy(layout);
  const newId = idsFrom(op, made);
  if (op.op === 'current' || op.op === 'dropWorld') {
    // Showing a world makes it, so its views stay alive (a terminal keeps its connection)
    // after the human moves on, as long as it's in the layout.
    if (op.op === 'current') {
      l.current = op.world;
      if (op.world !== null) l.agentWorlds[op.world] ??= defaultWorld(op.world);
    } else {
      delete l.agentWorlds[op.world];
      if (l.current === op.world) l.current = null;
    }
    l.version = layout.version + 1;
    return l;
  }
  const w = worldOf(l, op.world);
  switch (op.op) {
    case 'open': {
      const found = leaves(w.root).find((x) => x.tabs.includes(op.key));
      if (found) {
        found.active = op.key;
        if (!op.background) w.focused = found.id;
      } else {
        let target: Leaf = op.pane !== undefined ? leafIn(w, op.pane, op.world) : focusedLeaf(w);
        if (op.split) {
          const fresh: Leaf = { id: newId(), tabs: [op.key], active: op.key };
          splitBeside(w, target, fresh, op.split, newId);
          target = fresh;
        } else {
          const at = target.active ? target.tabs.indexOf(target.active) + 1 : target.tabs.length;
          target.tabs.splice(at, 0, op.key);
          target.active = op.key;
        }
        if (!op.background) w.focused = target.id;
      }
      break;
    }
    case 'close': {
      const f = tabIn(w, op.key, op.world);
      f.leaf.tabs.splice(f.index, 1);
      if (f.leaf.active === op.key) f.leaf.active = f.leaf.tabs[Math.min(f.index, f.leaf.tabs.length - 1)] ?? null;
      if (!f.leaf.tabs.length) removeLeaf(w, f.leaf);
      break;
    }
    // Shows `with` where `key` is, in the same pane and place (an agent's terminal and stam's
    // view of it trade places). A `with` open elsewhere in the world moves there, so the
    // world never shows it twice.
    case 'swap': {
      if (typeof op.with !== 'string' || !op.with) throw new Error('swap needs a tab key in with');
      if (op.with === op.key) { tabIn(w, op.key, op.world); break; }
      const f = tabIn(w, op.key, op.world);
      const other = leaves(w.root).find((x) => x.tabs.includes(op.with));
      if (other) {
        other.tabs.splice(other.tabs.indexOf(op.with), 1);
        if (other.active === op.with) other.active = other.tabs[0] ?? null;
        if (other !== f.leaf && !other.tabs.length) removeLeaf(w, other);
      }
      const at = f.leaf.tabs.indexOf(op.key);
      f.leaf.tabs[at] = op.with;
      if (f.leaf.active === op.key || f.leaf.active === null) f.leaf.active = op.with;
      break;
    }
    case 'move':
      doMove(w, op.world, op.key, op.to, op.before, op.side, newId);
      break;
    case 'split': {
      const l0 = leafIn(w, op.pane, op.world);
      if (l0.active && l0.tabs.length > 1) {
        doMove(w, op.world, l0.active, op.pane, null, op.side, newId);
        break;
      }
      const fresh: Leaf = { id: newId(), tabs: [], active: null };
      splitBeside(w, l0, fresh, op.side, newId);
      w.focused = fresh.id;
      break;
    }
    case 'closePane': {
      const l0 = leafIn(w, op.pane, op.world);
      if (leaves(w.root).length < 2) break;
      // Its tabs join the pane just before it (or just after, when it was first).
      const p = parentOf(w.root, l0)!;
      const sibling = p.parent.children[p.index - 1] ?? p.parent.children[p.index + 1];
      const intoId = leaves(sibling)[0].id;
      const keys = [...l0.tabs];
      removeLeaf(w, l0);
      const into = leafIn(w, intoId, op.world);
      for (const k of keys) if (!into.tabs.includes(k)) into.tabs.push(k);
      into.active = into.active ?? keys[0] ?? null;
      w.focused = into.id;
      break;
    }
    case 'activate': {
      const leaf = leafIn(w, op.pane, op.world);
      if (!leaf.tabs.includes(op.key)) throw new Error(`no tab ${op.key} in pane ${op.pane} of world ${op.world}`);
      leaf.active = op.key;
      break;
    }
    case 'focus':
      w.focused = leafIn(w, op.pane, op.world).id;
      break;
    case 'tabBar':
      leafIn(w, op.pane, op.world).showTabs = op.on;
      break;
    case 'resize': {
      const s = findSplit(w.root, op.split);
      if (!s) throw new Error(`no split ${op.split} in world ${op.world}`);
      if (!Array.isArray(op.sizes) || op.sizes.length !== s.children.length) throw new Error(`split ${op.split} needs ${s.children.length} sizes`);
      s.sizes = [...op.sizes];
      break;
    }
    case 'setRoot': {
      w.root = copy(op.root);
      const ls = leaves(w.root);
      if (!ls.length) throw new Error(`setRoot for world ${op.world} has no panes`);
      w.focused = (op.focusKey !== undefined ? ls.find((x) => x.tabs.includes(op.focusKey!)) : undefined)?.id ?? ls[0].id;
      if (op.meta) {
        delete w.tree; delete w.saved; delete w.mainPane; delete w.treeSig;
        Object.assign(w, copy(op.meta));
      }
      break;
    }
    default:
      throw new Error(`unknown layout op ${(op as { op: string }).op}`);
  }
  l.version = layout.version + 1;
  return l;
}
