// The read-only inventory of everything one agent (or one agent type) receives, for the web UI's
// Instructions view: the same parts as src/agent-instructions.ts, split into heading-level blocks
// with a token estimate and a text hash, plus the full skill text and the MCP tool schemas the
// older route only named. Nothing here changes a prompt (S-876 stage 1); withSummaries adds
// each block's summary for the routes (S-879).
//
// Layers, in the order the agent receives them:
//   system-prompt     every part stam renders for the prompt: its own literal text, the role, the
//                     type, the org paragraph, the cost rules, retros, lessons, ITSAs, requirements,
//                     the rules for mailing the user, and the instruction-files section (the note
//                     naming the files a harness skips and the user's instructions for all agents)
//   instruction-files every native CLAUDE.md/AGENTS.md file the harness loads itself, repo and
//                     user-global, as nativeFiles() gives them
//   first-prompt      the prompt the agent was spawned with (for a type, its brief with {{task}})
//   skills            one block per skill, its whole SKILL.md, from skillFolders()
//   mcp-instructions  the text stam's own MCP server sends at initialize
//   mcp-tools         one JSON block per stam MCP tool (name, description, inputSchema) and the
//                     names of the other MCP servers, whose schemas stam does not hold
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { ROOT } from './config.ts';
import type { Agent } from './db.ts';
import { agentInstructionParts, type InstructionPart } from './agent-instructions.ts';
import { extraMcpServers, instructionsDetail, skillFolders, typeSkillsBlock, GLOBAL_INSTRUCTIONS } from './instructions.ts';
import { agentTypes, renderBrief } from './agent-types.ts';
import { template, rendersFromBlocks } from './templates.ts';
import { enabled as requirementsEnabled } from './requirements.ts';
import { toolCatalog } from './mcp.ts';
import { summariesFor } from './block-summaries.ts';
import { allBlocks, usableReplacement, normalizeTypeBlocks, blocksOf, replacementFiles, COMPOSING, hasBlocks } from './blocks.ts';
import { mayMailHuman } from './settings.ts';

// Who a layer comes from. The system prompt and MCP instructions are stam's; a file can be in the
// agent's repo or the user's global harness config; a skill is a deployed SKILL.md; the MCP tool
// schemas come from the stam MCP server.
export type InventorySource = 'stam' | 'stam-generated' | 'repo' | 'user-global' | 'skill' | 'mcp';

export interface InventoryBlock {
  // Stable within a layer: layerKey:slug-of-heading-path, with -2, -3, ... for a repeat.
  id: string;
  title: string;
  headingPath: string[];
  tokens: number;
  // sha256 hex of the block text, so the web (and a later summary cache) can key on the content.
  hash: string;
  format: 'markdown' | 'text' | 'json';
  text: string;
  // Per-type composition (S-886), on the entries the system-prompt layer adds for a type's `blocks`:
  // 'off' (switched off by `by`), 'replaced' (the global block a type swapped out), 'replaces' (the
  // type's block in its place). These show what composition did and add no tokens: the rendered
  // text is already in the layer's other blocks.
  state?: 'off' | 'replaced' | 'replaces';
  by?: string;
}

// A block as the routes serve it: with a summary and where it came from. `summaryState` is
// 'auto' (a model wrote it, cached by hash), 'pending' (asked, not back yet), 'off' (no model set),
// 'failed' (the call failed since the daemon started), or 'source': the block is an MCP tool's JSON
// schema, which is never sent to a model, and its summary is the tool's own `description`.
export type SummaryState = 'auto' | 'pending' | 'off' | 'failed' | 'source';
export interface SummarizedBlock extends InventoryBlock {
  summary?: string;
  summaryState: SummaryState;
}

export interface InventoryLayer<B extends InventoryBlock = InventoryBlock> {
  key: string;
  label: string;
  source: InventorySource;
  path?: string;
  origin?: string;
  tokens: number;
  blocks: B[];
}

export interface InventoryFlag {
  kind: string;
  message: string;
  layer?: string;
}

export interface Inventory<B extends InventoryBlock = InventoryBlock> {
  agent?: { id: string; name: string; type: string | null; harness: string; model: string | null };
  type?: string;
  harness: string;
  totalTokens: number;
  layers: InventoryLayer<B>[];
  flags: InventoryFlag[];
}

// Tokens are estimated as characters/4, the rough rule stam uses elsewhere (src/req-check.ts). Kept
// in one function so a real tokenizer (or the harness's own count) can replace it later without
// touching the routes.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const FILE_LIMIT = 50_000;
// A block thinner than this many tokens is merged into the next block in the same part.
const MIN_BLOCK_TOKENS = 50;
// Harnesses that load skills. Claude Code gets a plugin, OpenCode a linked skills folder; Codex
// has no skills, so its skills layer is informational only.
const SKILL_HARNESSES = new Set(['claude', 'opencode']);

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(0, FILE_LIMIT);
  } catch {
    return '';
  }
}

const realOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function slug(text: string): string {
  const out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out.slice(0, 60) || 'block';
}

interface RawBlock {
  headingPath: string[];
  text: string;
}

const HEADING = /^(#{1,3})\s+(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

// Split one part of text into blocks at its headings (# to ###), keeping each block's heading path.
// A heading line inside a fenced code block is text, not a heading, so no block ends mid-fence.
// Text before the first heading is its own block with an empty path.
export function splitIntoBlocks(text: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  let current: RawBlock = { headingPath: [], text: '' };
  blocks.push(current);
  const path: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const f = FENCE.exec(line);
    if (fence) {
      // Only a fence at least as long as the opener closes it.
      if (f && line.trim().startsWith(fence)) fence = null;
      current.text += line + '\n';
      continue;
    }
    if (f) {
      fence = f[1];
      current.text += line + '\n';
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      path.length = level - 1;
      path[level - 1] = h[2].trim();
      current = { headingPath: path.filter((s): s is string => typeof s === 'string' && s !== ''), text: line + '\n' };
      blocks.push(current);
      continue;
    }
    current.text += line + '\n';
  }
  // A part that starts with a heading leaves an empty first block; drop the empties.
  return blocks.filter((b) => b.text.trim() !== '');
}

// A block thinner than ~50 tokens is noise on its own: its text prepends the block after it in the
// same part. A tiny final block has nothing after it and stays as it is.
function mergeTiny(blocks: RawBlock[]): RawBlock[] {
  const out: RawBlock[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (last && estimateTokens(last.text) < MIN_BLOCK_TOKENS) {
      out[out.length - 1] = { headingPath: b.headingPath, text: last.text + b.text };
      continue;
    }
    out.push(b);
  }
  return out;
}

interface LayerBuilder {
  layer: InventoryLayer;
  ids: Map<string, number>;
}

function newLayer(key: string, label: string, source: InventorySource, extra: { path?: string; origin?: string } = {}): LayerBuilder {
  return { layer: { key, label, source, ...extra, tokens: 0, blocks: [] }, ids: new Map() };
}

// One block, with its id deduped against `ids` (the layer's, or a fresh one for a single part):
// the first block with a heading path keeps `layerKey:slug`, the next gets `-2`, and so on.
function makeBlock(layerKey: string, title: string, headingPath: string[], raw: string, format: InventoryBlock['format'], ids: Map<string, number>): InventoryBlock {
  const text = raw.replace(/\s+$/, '');
  const stem = `${layerKey}:${slug(headingPath.length ? headingPath.join(' ') : title)}`;
  const n = ids.get(stem) ?? 0;
  ids.set(stem, n + 1);
  return {
    id: n ? `${stem}-${n + 1}` : stem,
    title,
    headingPath,
    tokens: estimateTokens(text),
    hash: createHash('sha256').update(text, 'utf8').digest('hex'),
    format,
    text,
  };
}

// Split one part of text into its blocks. `root` is a heading path prefixed to every block, for a
// file shown as a whole (its basename), so its blocks stay identifiable and unique. Exported for
// the unit test; the routes call it through a layer.
export function partBlocks(layerKey: string, text: string, format: InventoryBlock['format'], fallbackTitle: string, root: string[] = [], ids = new Map<string, number>()): InventoryBlock[] {
  return mergeTiny(splitIntoBlocks(text)).map((raw) =>
    makeBlock(layerKey, raw.headingPath.length ? raw.headingPath[raw.headingPath.length - 1] : fallbackTitle, [...root, ...raw.headingPath], raw.text, format, ids),
  );
}

function addPart(layer: InventoryLayer, ids: Map<string, number>, text: string, format: InventoryBlock['format'], fallbackTitle: string, root: string[] = []): void {
  for (const b of partBlocks(layer.key, text, format, fallbackTitle, root, ids)) {
    layer.blocks.push(b);
    layer.tokens += b.tokens;
  }
}

// Add exactly one block, without splitting by heading (a skill is one block whatever its headings).
function addWhole(layer: InventoryLayer, ids: Map<string, number>, title: string, headingPath: string[], text: string, format: InventoryBlock['format']): void {
  const b = makeBlock(layer.key, title, headingPath, text, format, ids);
  layer.blocks.push(b);
  layer.tokens += b.tokens;
}

// What the agent's type switched off or replaced, as state entries after the layer's blocks.
function addComposition(layer: InventoryLayer, a: Agent, flags: InventoryFlag[]): void {
  const by = a.type;
  const { blocks: tb, problems } = normalizeTypeBlocks(by ? agentTypes()[by]?.blocks : undefined);
  if (!by) return;
  const known = allBlocks();
  const entry = (id: string, state: 'off' | 'replaced' | 'replaces', title: string, text: string, kind: string) => {
    const t = text.replace(/\s+$/, '');
    layer.blocks.push({ id: `${layer.key}:${kind}-${id}`, title, headingPath: [], tokens: estimateTokens(t), hash: createHash('sha256').update(t, 'utf8').digest('hex'), format: 'markdown', text: t, state, by });
  };
  const flag = (message: string) => flags.push({ kind: 'composition-ignored', layer: layer.key, message });
  for (const p of problems) flag(`${by}: ${p}, so it is ignored.`);
  // The block's template must be the text this agent gets: not overridden by a whole file, and for
  // the mail rules, the one its model is given.
  const applies = (id: string): boolean => {
    const t = known.get(id)?.template;
    if (!t) return false;
    if (!rendersFromBlocks(t)) {
      flag(`${by} changes block ${id}, but the ${t} template is overridden by a whole file, so it is ignored.`);
      return false;
    }
    if ((t === 'mail-to-human' && !mayMailHuman(a.model)) || (t === 'mail-to-human-restricted' && mayMailHuman(a.model))) {
      flag(`${by} changes block ${id}, but this agent's model gets the other mail rules, so it is ignored.`);
      return false;
    }
    return true;
  };
  for (const id of tb.off ?? []) {
    const g = known.get(id)?.block;
    if (g) {
      if (applies(id)) entry(id, 'off', g.title, g.body, 'off');
    }
    else flag(`${by} switches off block ${id}, which isn't a block of a template a type composes, so it is ignored.`);
  }
  for (const [id, path] of Object.entries(tb.replace ?? {})) {
    const g = known.get(id)?.block;
    if (!g) {
      flag(`${by} replaces block ${id}, which isn't a block of a template a type composes, so it is ignored.`);
      continue;
    }
    if (!applies(id)) continue;
    const r = usableReplacement(path);
    if (!r) {
      flag(`${by} replaces block ${id} with ${path}, which is missing, outside blocks/, or not a block, so the agent gets the global block.`);
      continue;
    }
    entry(id, 'replaced', g.title, g.body, 'replaced');
    entry(id, 'replaces', r.title, r.body, 'replaces');
  }
}

// The parts agent-instructions.ts builds are the single source of truth; here they are split and
// classified, never re-derived. A part is a native instruction file (whose contents the harness
// loads itself) when it comes from the repo or the user's global harness config; everything else
// stam renders is the system prompt.
const isNativeFilePart = (p: InstructionPart): boolean => p.source === 'repo' || p.source === 'user-global';
// Parts agentInstructionParts() adds that the inventory replaces with its own, full-text layers.
const REPLACED_LABELS = new Set(['First prompt', 'Skills', 'MCP servers', 'Harness built-in prompt']);

// Build every layer and the provable flags, for any agent-like object (a real agent or the
// synthetic one a type route makes).
function build(a: Agent): { layers: InventoryLayer[]; flags: InventoryFlag[] } {
  const layers: InventoryLayer[] = [];
  const flags: InventoryFlag[] = [];
  const parts = agentInstructionParts(a).parts;
  const detail = instructionsDetail(a.harness, a.cwd);

  const systemPrompt = newLayer('system-prompt', 'System prompt', 'stam-generated', { origin: 'system-prompt' });
  for (const p of parts) if (!isNativeFilePart(p) && !REPLACED_LABELS.has(p.label)) addPart(systemPrompt.layer, systemPrompt.ids, p.text, p.format, p.label);
  addComposition(systemPrompt.layer, a, flags);
  const typeSkills = a.type ? agentTypes()[a.type]?.skills : undefined;
  if (typeSkills?.length) for (const n of typeSkillsBlock(typeSkills).missing) flags.push({ kind: 'type-skill-missing', layer: 'system-prompt', message: `${a.type} names skill ${n}, which isn't installed, so it is left out of the Skills available block.` });
  layers.push(systemPrompt.layer);

  const native = detail.native;
  const fileSource: InventorySource = native.some((f) => f.source === 'repo') ? 'repo' : native.some((f) => f.source === 'user-global') ? 'user-global' : 'stam';
  const instructionFiles = newLayer('instruction-files', 'Instruction files', fileSource, { origin: 'instruction-files', ...(native.length === 1 ? { path: native[0].path } : {}) });
  for (const f of native) addPart(instructionFiles.layer, instructionFiles.ids, readText(f.path), 'markdown', basename(f.path), [basename(f.path)]);
  layers.push(instructionFiles.layer);

  const firstPrompt = newLayer('first-prompt', 'First prompt', 'stam');
  addPart(firstPrompt.layer, firstPrompt.ids, a.first_prompt ?? 'Not recorded for this agent.', 'markdown', 'First prompt');
  layers.push(firstPrompt.layer);

  const skills = newLayer('skills', 'Skills', 'skill');
  for (const s of [...skillFolders()].sort((x, y) => x.name.localeCompare(y.name))) addWhole(skills.layer, skills.ids, s.name, [s.name], readText(join(s.path, 'SKILL.md')), 'markdown');
  layers.push(skills.layer);

  const mcpInstructions = newLayer('mcp-instructions', 'MCP instructions', 'stam');
  addPart(mcpInstructions.layer, mcpInstructions.ids, template('mcp-instructions'), 'markdown', 'MCP instructions');
  layers.push(mcpInstructions.layer);

  const mcpTools = newLayer('mcp-tools', 'MCP tools', 'mcp');
  for (const group of toolCatalog({ requirements: requirementsEnabled() }).groups)
    for (const t of group.tools) addWhole(mcpTools.layer, mcpTools.ids, t.name, [], JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }, null, 2), 'json');
  const extra = Object.keys(extraMcpServers()).sort();
  if (extra.length) addWhole(mcpTools.layer, mcpTools.ids, 'Other MCP servers', [], extra.map((n) => `- ${n}`).join('\n'), 'text');
  layers.push(mcpTools.layer);

  // Flags: only what the inventory can prove from the files on disk.

  // The same file reached twice: a harness loads CLAUDE.md while the note tells it to read
  // AGENTS.md, which is a symlink to it. Compare the realpath of every file in the layer.
  const paths = new Set<string>(native.map((f) => f.path));
  for (const line of detail.note.split('\n')) {
    const m = /^-\s+(.+)$/.exec(line);
    if (m) paths.add(isAbsolute(m[1]) ? m[1] : resolve(a.cwd, m[1]));
  }
  const byReal = new Map<string, string[]>();
  for (const p of paths) byReal.set(realOrSelf(p), [...(byReal.get(realOrSelf(p)) ?? []), p]);
  for (const [real, list] of byReal) if (new Set(list).size > 1) flags.push({ kind: 'duplicate-file', layer: 'instruction-files', message: `${list.join(' and ')} are the same file (${real}), so the agent is given it twice.` });

  // A file that exists but holds nothing (a 0-byte instructions.md, say).
  const emptyFile = (path: string | undefined, layer: string) => {
    if (path && sizeOf(path) === 0) flags.push({ kind: 'empty-file', layer, message: `${path} is empty (0 bytes).` });
  };
  for (const f of native) emptyFile(f.path, 'instruction-files');
  emptyFile(existsSync(GLOBAL_INSTRUCTIONS) ? GLOBAL_INSTRUCTIONS : undefined, 'instruction-files');
  for (const s of skillFolders()) emptyFile(join(s.path, 'SKILL.md'), 'skills');

  // A layer with no blocks at all.
  for (const l of layers) if (!l.blocks.length) flags.push({ kind: 'empty-layer', layer: l.key, message: `${l.label} is empty.` });

  // Skills on a harness that can't load them.
  if (!SKILL_HARNESSES.has(a.harness)) flags.push({ kind: 'skills-unsupported', layer: 'skills', message: `${a.harness} can't load skills, so the skills layer (${skillFolders().length}) is only informational here.` });

  return { layers, flags };
}

const total = (layers: InventoryLayer[]): number => layers.reduce((n, l) => n + l.tokens, 0);

// Everything one real agent receives. The daemon loads the agent's owned ITSAs first (itsaOwners),
// so the itsa part is right.
export function agentInventory(a: Agent): Inventory {
  const { layers, flags } = build(a);
  return { agent: { id: a.id, name: a.name, type: a.type, harness: a.harness, model: a.model }, harness: a.harness, totalTokens: total(layers), layers, flags };
}

// Everything an agent of `name` would receive, as a synthetic agent of that type: the type's
// harness and model from the registry unless `harness` overrides (then the model is dropped, since
// it belongs to the type's own harness), starting in the daemon's own repo, with no ITSAs, and a
// first prompt that is the type's brief with {{task}} left as the placeholder it is.
export function typeInventory(name: string, harness?: string): Inventory {
  const t = agentTypes()[name];
  if (!t) throw new Error(`no agent type ${name}`);
  const h = harness ?? t.harness;
  const brief = t.brief ? renderBrief(t, { task: '{{task}}', name, type: name, parent: 'human', cwd: ROOT, branch: '' }) : undefined;
  const a = {
    id: `type:${name}`,
    name,
    role: t.description,
    type: name,
    harness: h,
    model: harness && harness !== t.harness ? null : t.model,
    cwd: ROOT,
    first_prompt: brief ?? null,
    kind: null,
  } as unknown as Agent;
  const { layers, flags } = build(a);
  return { type: name, harness: h, totalTokens: total(layers), layers, flags };
}
// The tool's own description, for an `mcp-tools` JSON block; undefined when the text isn't that JSON.
function toolDescription(b: InventoryBlock): string | undefined {
  if (b.format !== 'json') return undefined;
  try {
    const d = JSON.parse(b.text)?.description;
    return typeof d === 'string' && d.trim() ? d.trim() : undefined;
  } catch {
    return undefined;
  }
}

// Add a summary and its state to every block (S-879). Tool schemas are never sent to a model: their
// description is the summary (state 'source'). Everything else goes through summariesFor, which
// returns at once; a block still 'pending' has its model call queued in the background, so the web
// asks again until none is.
export function withSummaries(inv: Inventory): Inventory<SummarizedBlock> {
  const asked = inv.layers.flatMap((l) => l.blocks.filter((b) => toolDescription(b) === undefined).map((b) => ({ hash: b.hash, text: b.text, title: b.title })));
  const sums = summariesFor(asked);
  return {
    ...inv,
    layers: inv.layers.map((l) => ({
      ...l,
      blocks: l.blocks.map((b): SummarizedBlock => {
        const d = toolDescription(b);
        if (d !== undefined) return { ...b, summary: d, summaryState: 'source' };
        const s = sums[b.hash];
        return { ...b, ...(s.summary !== undefined ? { summary: s.summary } : {}), summaryState: s.state };
      }),
    })),
  };
}

// What the type composer (S-892) offers: the blocks of the composing templates in their global order,
// and the replacement files under blocks/_replace/, each with its estimated tokens. `rendered` is false
// for a template a whole file overrides, whose blocks a type's composition can't change. `applies` is
// false for the mail rules the type's agent doesn't get: the model of an agent of the type on `harness`
// (the type's own unless given) either may mail the human or gets the restricted rules.
export interface ComposerBlock { id: string; title: string; summary: string; tokens: number; template: string; rendered: boolean; applies: boolean }
export interface ComposerCatalog { blocks: ComposerBlock[]; replacements: Array<{ path: string; id: string; title: string; summary: string; tokens: number }> }
export function composerCatalog(type?: string, harness?: string): ComposerCatalog {
  const t = type ? agentTypes()[type] : undefined;
  const model = t && !(harness && harness !== t.harness) ? t.model ?? null : null;
  const gets = (template: string) => (template === 'mail-to-human' ? mayMailHuman(model) : template === 'mail-to-human-restricted' ? !mayMailHuman(model) : true);
  const blocks = COMPOSING.filter(hasBlocks).flatMap((template) => {
    const rendered = rendersFromBlocks(template);
    return blocksOf(template).map((b) => ({ id: b.id, title: b.title, summary: b.summary.replace(/\s+/g, ' ').trim(), tokens: estimateTokens(b.body.replace(/\s+$/, '')), template, rendered, applies: gets(template) }));
  });
  const replacements = replacementFiles().map((b) => ({ path: b.file, id: b.id, title: b.title, summary: b.summary.replace(/\s+/g, ' ').trim(), tokens: estimateTokens(b.body.replace(/\s+$/, '')) }));
  return { blocks, replacements };
}
