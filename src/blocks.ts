import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { ROOT } from './config.ts';

// Block files (S-883): stam's own instruction text, split into files under blocks/NAME/ with a
// frontmatter header. A template built from blocks is the bodies concatenated in filename order,
// so the text an agent gets is the text of the files, verbatim. The header is:
//   ---
//   id: kill-by-pid            stable name
//   title: ...                 short label
//   summary: |                 two lines at most, written by the author
//     ...
//   scope: global
//   kind: rule                 rule | recipe | process | context | skill | memory
//   applies: [claude, codex]   optional harness list
//   summary_of: <sha256>       hash of the body the summary was written for
//   ---
export type Block = { file: string; id: string; title: string; summary: string; scope: string; kind: string; applies?: string[]; summary_of: string; body: string };

export const blockHash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');

export function parseBlock(file: string, raw: string): Block {
  raw = raw.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!m) throw new Error(`block ${file}: no frontmatter`);
  const f: Record<string, string> = {};
  let key = '';
  for (const line of m[1].split('\n')) {
    if (/^\s/.test(line) && key) f[key] += `${f[key] ? '\n' : ''}${line.trim()}`;
    else {
      const kv = /^(\w+):\s*(.*)$/.exec(line);
      if (!kv) throw new Error(`block ${file}: bad frontmatter line "${line}"`);
      key = kv[1];
      f[key] = kv[2] === '|' || kv[2] === '>' ? '' : kv[2];
    }
  }
  for (const k of ['id', 'title', 'summary', 'scope', 'kind', 'summary_of']) if (!f[k]) throw new Error(`block ${file}: no ${k}`);
  const applies = f.applies ? f.applies.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  return { file, id: f.id, title: f.title, summary: f.summary, scope: f.scope, kind: f.kind, applies, summary_of: f.summary_of, body: raw.slice(m[0].length) };
}

const dirOf = (name: string) => join(ROOT, 'blocks', name);

// The blocks of one template, in filename order; none when the template isn't built from blocks.
export function blocksOf(name: string): Block[] {
  const dir = dirOf(name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => parseBlock(f, readFileSync(join(dir, f), 'utf8')));
}

// A folder starting with `_` holds files a type's `replace` points at, not a template.
export const hasBlocks = (name: string) => !name.startsWith('_') && existsSync(dirOf(name));

// A memory block (S-888) always starts a paragraph of its own: the block before it is closed with a
// blank line when its file ends after a single newline. Every other join is the bodies verbatim.
export const blocksText = (name: string) => blocksOf(name).map((b, i, all) => (all[i + 1]?.kind === 'memory' && !/\n\n$/.test(b.body) ? `${b.body.replace(/\n?$/, '\n')}\n` : b.body)).join('');

// Per-type composition (S-886): an agent type switches off or replaces blocks of the global
// templates. `off` lists block ids; `replace` maps a block id to the file whose body takes its
// place (relative to the repo root, or absolute). Text is never merged: a block is dropped, or
// swapped whole.
export interface TypeBlocks {
  off?: string[];
  replace?: Record<string, string>;
  // Block ids in the order they appear in their template (S-892). A template's blocks that are listed
  // come in this order; blocks it doesn't list (a block added later) follow in filename order.
  order?: string[];
}

// The templates rendered for an agent of a type, so the only ones whose blocks a type can switch
// off or replace. Others (itsa, requirements, the type-* and org texts) are built from the agent,
// not its type, and would ignore the composition.
export const COMPOSING = ['system-prompt', 'retro', 'mail-to-human', 'mail-to-human-restricted'];

// Every block of the composing templates by id, with the template folder it belongs to.
export function allBlocks(): Map<string, { template: string; block: Block }> {
  const out = new Map<string, { template: string; block: Block }>();
  for (const t of COMPOSING) if (hasBlocks(t)) for (const block of blocksOf(t)) out.set(block.id, { template: t, block });
  return out;
}

// A replacement file, which must be a block file inside blocks/ once symlinks are resolved: the
// registry is editable by agents, so a path is never trusted. Throws when it isn't.
export function replacementBlock(path: string): Block {
  const base = realpathSync(join(ROOT, 'blocks'));
  const file = realpathSync(path.startsWith('/') ? path : join(ROOT, path));
  if (!file.startsWith(base + sep)) throw new Error(`${path} is not inside blocks/`);
  return parseBlock(path, readFileSync(file, 'utf8'));
}

// The replacement, or null when it can't be used (missing, outside blocks/, not a block): a render
// never throws on it and falls back to the global block.
export function usableReplacement(path: string): Block | null {
  try {
    return replacementBlock(path);
  } catch {
    return null;
  }
}

// A type's `blocks` as the registry holds it (an agent can hand-edit it) cleaned to the valid
// shape: `off` a list of strings, `replace` an object of string paths. What is dropped is named in
// `problems`, so the inventory can flag it; a render just ignores it.
export function normalizeTypeBlocks(raw: unknown): { blocks: TypeBlocks; problems: string[] } {
  const blocks: TypeBlocks = {};
  const problems: string[] = [];
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!r) return { blocks, problems: raw == null ? [] : ['blocks is not an object'] };
  if (r.off != null) {
    if (Array.isArray(r.off)) {
      const ok = r.off.filter((i): i is string => typeof i === 'string');
      if (ok.length) blocks.off = ok;
      if (ok.length !== r.off.length) problems.push('blocks.off has entries that are not block ids');
    } else problems.push('blocks.off is not a list');
  }
  if (r.replace != null) {
    if (typeof r.replace === 'object' && !Array.isArray(r.replace)) {
      const ok = Object.entries(r.replace).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '');
      if (ok.length) blocks.replace = Object.fromEntries(ok);
      if (ok.length !== Object.keys(r.replace).length) problems.push('blocks.replace has entries that are not file paths');
    } else problems.push('blocks.replace is not an object');
  }
  if (r.order != null) {
    if (Array.isArray(r.order)) {
      const ok = r.order.filter((i): i is string => typeof i === 'string');
      if (ok.length) blocks.order = [...new Set(ok)];
      if (ok.length !== r.order.length) problems.push('blocks.order has entries that are not block ids');
    } else problems.push('blocks.order is not a list');
  }
  return { blocks, problems };
}

export const hasComposition = (tb?: TypeBlocks | null): boolean => Boolean(tb && (tb.off?.length || Object.keys(tb.replace ?? {}).length || tb.order?.length));

// The blocks of one template for an agent of a type: its `off` blocks dropped, its `replace` blocks
// swapped for the replacement's body. Without composition, exactly blocksOf(name).
export function composedBlocks(name: string, raw?: TypeBlocks | null): Block[] {
  const blocks = blocksOf(name);
  const tb = normalizeTypeBlocks(raw).blocks;
  if (!hasComposition(tb)) return blocks;
  const off = new Set(tb.off ?? []);
  const replace = tb.replace ?? {};
  const rank = new Map((tb.order ?? []).map((id, i) => [id, i]));
  return blocks.filter((b) => !off.has(b.id)).map((b) => {
    const r = replace[b.id] ? usableReplacement(replace[b.id]) : null;
    return r ? { ...b, body: r.body } : b;
  }).sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || 0);
}

// Replacement files a type can point `replace` at: the block files in blocks/_replace/ (S-892),
// where they stay apart from any template.
export const REPLACE_DIR = 'blocks/_replace';
export function replacementFiles(): Block[] {
  const dir = join(ROOT, REPLACE_DIR);
  if (!existsSync(dir)) return [];
  const out: Block[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const path = `${REPLACE_DIR}/${f}`;
    const r = usableReplacement(path);
    if (r) out.push({ ...r, file: path });
  }
  return out;
}

export const composedText = (name: string, tb?: TypeBlocks | null) => composedBlocks(name, tb).map((b) => b.body).join('');

// Type memory (S-888): each agent type may have one block of notes, "Before you start", in its own
// template folder as `99-memory.md` (kind memory, scope type:NAME), so it renders last in that
// type's instructions and for agents of that type only; a type without the file renders as before.
// Only the retro steward writes it, in a proposal your user approves (retro-loop.ts), and a memory
// block is at most MEMORY_MAX_TOKENS (about four characters a token).
export const MEMORY_FILE = '99-memory.md';
export const MEMORY_TITLE = 'Before you start';
export const MEMORY_MAX_TOKENS = 400;
export const MEMORY_MAX_CHARS = MEMORY_MAX_TOKENS * 4;
export const memoryPath = (type: string) => `blocks/type-${type}/${MEMORY_FILE}`;

// The type's memory block, or undefined when it has none.
export const memoryBlock = (type: string): Block | undefined => blocksOf(`type-${type}`).find((b) => b.file === MEMORY_FILE);

// The ids of a type's blocks: what the retro steward names as an item's target.
export const blockIdsOf = (type: string): string[] => blocksOf(`type-${type}`).map((b) => b.id);

// The reason a memory block file is not valid for the type, or null.
export function memoryProblem(type: string, b: Block): string | null {
  if (b.kind !== 'memory') return `${memoryPath(type)} must have kind memory`;
  if (b.scope !== `type:${type}`) return `${memoryPath(type)} must have scope type:${type}`;
  if (b.title !== MEMORY_TITLE) return `${memoryPath(type)} must be titled "${MEMORY_TITLE}"`;
  if (b.body.length > MEMORY_MAX_CHARS) return `${memoryPath(type)} is about ${Math.round(b.body.length / 4)} tokens, over ${MEMORY_MAX_TOKENS}`;
  return null;
}
