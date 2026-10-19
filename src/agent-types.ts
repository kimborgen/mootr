// Agent types: saved roles (developer, reviewer, manager) a manager spawns by name. Each is
// a registry entry under `types` with a description of when to use it, a preset (harness,
// model, effort), optional default visibility and child notices, and an optional brief
// template; its own instructions are the template `type-NAME`, added to the system prompt
// of every agent of that type.
import { join } from 'node:path';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { ROOT, STAM_HOME } from './config.ts';
import { registry } from './registry.ts';
import { skillFolders } from './instructions.ts';
import { allBlocks, replacementBlock, type TypeBlocks } from './blocks.ts';
import { nextSteps } from './process-brief-fallback.ts';

// How a ring review runs (S-412): the members and the optional moderator are agent types.
export interface RingConfig {
  format: 'rounds' | 'fire' | 'debate';
  members: string[];
  moderator: { type: string; decides: boolean } | null;
  maxRounds: number;
}

// A type with `review` is a reviewer type. `fallback` is another reviewer type that takes over
// when this one's account is held; `ring` makes the type a ring of other types (no harness).
export interface ReviewConfig {
  fallback: string | null;
  ring: RingConfig | null;
}

export interface AgentType {
  description: string;
  // Empty for a ring type, which spawns its members instead.
  harness: string;
  model: string | null;
  effort: string | null;
  visibility?: { reach?: 'all' | 'tree' | 'parent'; siblings?: boolean; registry?: boolean } | null;
  child_notices?: 'turn' | 'tree-idle' | 'none' | null;
  // A type's default workspace (S-627): true gives every agent of the type its own git worktree,
  // unless the spawner passes `worktree` itself. The developer type ships with it, so a manager
  // that forgets the flag can't leave a developer committing in the live deploy checkout.
  worktree?: boolean | null;
  // The first prompt, with {{task}} (the spawner's prompt), {{name}}, {{type}}, {{parent}},
  // {{cwd}}, {{branch}}, {{next_steps}} (the type's lane steps from processes/, S-925), and any
  // variables the spawner passes.
  brief?: string | null;
  review?: ReviewConfig | null;
  // Global blocks this type switches off or replaces in its agents' prompts (S-886).
  blocks?: TypeBlocks | null;
  // Skill names (folders from skillFolders()) the type's agents get as a "Skills available" block (S-891).
  skills?: string[] | null;
}

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const typeTemplate = (name: string) => `type-${name}`;

export function agentTypes(): Record<string, AgentType> {
  return registry().types ?? {};
}

export function agentType(name: string): AgentType {
  const t = agentTypes()[name];
  if (!t) throw new Error(`no agent type ${name}; see stam registry`);
  return t;
}

export const isReviewerType = (name: string): boolean => Boolean(agentTypes()[name]?.review);

export function reviewerTypes(): string[] {
  return Object.entries(agentTypes()).filter(([, t]) => t.review).map(([n]) => n);
}

// The reviewer type a plain review uses (registry key `defaultReviewer`).
export function defaultReviewer(): string {
  const d = registry().defaultReviewer;
  return typeof d === 'string' && d ? d : 'reviewer';
}

// The ordered fallback types of a reviewer type: its fallback, that one's fallback, and so on.
// Stops before a type already in the chain, so a cycle ends the list.
export function fallbackChain(name: string): string[] {
  const types = agentTypes();
  const seen = new Set([name]);
  const out: string[] = [];
  for (let n = types[name]?.review?.fallback; n && !seen.has(n) && types[n]; n = types[n].review?.fallback) {
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function isShipped(name: string): boolean {
  return Boolean(JSON.parse(readFileSync(join(ROOT, 'registry', 'defaults.json'), 'utf8')).types?.[name]);
}

// The brief: the type's template filled in, or the task alone when the type has none.
// Without a task there is no brief, so an agent spawned idle stays idle.
export function renderBrief(t: AgentType, vars: Record<string, string>): string | undefined {
  if (!vars.task) return undefined;
  if (!t.brief) return vars.task;
  const brief = t.brief.includes('{{next_steps}}') ? t.brief.replace('{{next_steps}}', () => vars.next_steps ?? nextSteps(vars.type ?? '')) : t.brief;
  return brief.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '').trim();
}

const userRegistry = () => join(STAM_HOME, 'registry.json');
function readUser(): any {
  try {
    return JSON.parse(readFileSync(userRegistry(), 'utf8'));
  } catch (e) {
    if (existsSync(userRegistry())) throw new Error(`registry.json is not valid JSON: ${e instanceof Error ? e.message : e}`);
    return {};
  }
}
const writeUser = (r: any) => writeFileSync(userRegistry(), JSON.stringify(r, null, 2) + '\n');

// Adds or replaces a type in the user's registry.json, checked against the registry.
// A `default: true` input also makes it the default reviewer.
export function saveType(name: string, input: any): AgentType {
  if (!NAME_RE.test(name)) throw new Error('a type name must be lowercase letters, digits, and dashes');
  const r = registry();
  const review = parseReview(name, input.review, r.types ?? {});
  const harness = String(input.harness ?? '');
  if (review?.ring) {
    if (harness) throw new Error('a ring type has no harness');
  } else if (!r.harnesses[harness]) throw new Error(`unknown harness ${harness}`);
  if (input.default === true && !review) throw new Error('only a reviewer type can be the default reviewer');
  if (!review) {
    if (input.default !== true && defaultReviewer() === name) throw new Error(`${name} is the default reviewer, so it must keep its review config`);
    const fb = Object.entries(r.types ?? {}).filter(([n, o]: [string, any]) => n !== name && o.review?.fallback === name).map(([n]) => n);
    if (fb.length) throw new Error(`${name} is the fallback of ${fb.join(', ')}, so it must keep its review config`);
  }
  const effort = input.effort ? String(input.effort) : null;
  if (effort && !(r.harnesses[harness]?.efforts ?? []).includes(effort)) throw new Error(`${harness} has no effort ${effort}`);
  const t: AgentType = { description: String(input.description ?? '').trim(), harness, model: input.model ? String(input.model) : null, effort };
  if (review) t.review = review;
  if (input.child_notices) {
    if (!['turn', 'tree-idle', 'none'].includes(input.child_notices)) throw new Error('child notices must be turn, tree-idle, or none');
    t.child_notices = input.child_notices;
  }
  if (input.worktree !== undefined && input.worktree !== null) t.worktree = Boolean(input.worktree);
  if (input.visibility && typeof input.visibility === 'object') {
    const v = input.visibility;
    if (v.reach && !['all', 'tree', 'parent'].includes(v.reach)) throw new Error('reach must be all, tree, or parent');
    t.visibility = v;
  }
  if (input.brief && String(input.brief).trim()) t.brief = String(input.brief);
  const blocks = parseBlocks(input.blocks);
  if (blocks) t.blocks = blocks;
  const skills = parseSkills(input.skills, agentTypes()[name]?.skills ?? []);
  if (skills) t.skills = skills;
  const user = readUser();
  user.types = { ...user.types, [name]: t };
  if (input.default === true) user.defaultReviewer = name;
  writeUser(user);
  return t;
}

// Checks a type's skills: a list of names of skill folders that exist. A name the type already had
// stays even when its folder is gone (the inventory flags it), so a save of other fields isn't refused.
// Undefined when empty.
function parseSkills(raw: any, had: string[]): string[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string')) throw new Error('skills must be a list of skill names');
  const known = new Set(skillFolders().map((s) => s.name));
  for (const s of raw) if (!known.has(s) && !had.includes(s)) throw new Error(`unknown skill ${s}`);
  const out = [...new Set<string>(raw)];
  return out.length ? out : undefined;
}

// Checks a type's block composition: `off` ids and `replace` keys must be shipped block ids, a
// replacement file must exist and parse as a block, and a block can't be both off and replaced.
// Returns undefined when the type composes nothing.
function parseBlocks(raw: any): TypeBlocks | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('blocks must be an object');
  const known = allBlocks();
  const off: string[] = raw.off ?? [];
  if (!Array.isArray(off) || off.some((i) => typeof i !== 'string')) throw new Error('blocks.off must be a list of block ids');
  const rep = raw.replace ?? {};
  if (typeof rep !== 'object' || Array.isArray(rep)) throw new Error('blocks.replace must map block ids to files');
  for (const id of [...off, ...Object.keys(rep)]) if (!known.has(id)) throw new Error(`unknown block id ${id}`);
  for (const [id, path] of Object.entries(rep)) {
    if (off.includes(id)) throw new Error(`block ${id} is both off and replaced`);
    if (typeof path !== 'string' || !path) throw new Error(`blocks.replace.${id} must be a file path`);
    try {
      replacementBlock(path);
    } catch (e) {
      throw new Error(`replacement for ${id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  const order: string[] = raw.order ?? [];
  if (!Array.isArray(order) || order.some((i) => typeof i !== 'string')) throw new Error('blocks.order must be a list of block ids');
  for (const id of order) if (!known.has(id)) throw new Error(`unknown block id ${id}`);
  if (new Set(order).size !== order.length) throw new Error('blocks.order lists a block id twice');
  const out: TypeBlocks = {};
  if (off.length) out.off = [...new Set(off)];
  if (Object.keys(rep).length) out.replace = { ...rep };
  if (order.length) out.order = [...order];
  return out.off || out.replace || out.order ? out : undefined;
}

// Sets the default reviewer in the user's registry.json; it must be a reviewer type.
export function setDefaultReviewer(name: string): void {
  if (!isReviewerType(name)) throw new Error(`${name} is not a reviewer type`);
  const user = readUser();
  user.defaultReviewer = name;
  writeUser(user);
}

// Checks a review config against the registry's types; `self` is the type being saved, which
// can't be its own fallback or a member. Returns null when the type isn't a reviewer.
function parseReview(self: string, raw: any, types: Record<string, AgentType>): ReviewConfig | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('review must be an object');
  const fb = raw.fallback ?? null;
  if (fb !== null) {
    if (typeof fb !== 'string' || !types[fb]?.review) throw new Error(`fallback ${String(fb)} is not a reviewer type`);
    if (fb === self) throw new Error('a type cannot be its own fallback');
  }
  let ring: RingConfig | null = null;
  if (raw.ring != null) {
    const g = raw.ring;
    if (typeof g !== 'object' || Array.isArray(g)) throw new Error('ring must be an object');
    if (!['rounds', 'fire', 'debate'].includes(g.format)) throw new Error('ring format must be rounds, fire, or debate');
    if (!Array.isArray(g.members) || g.members.length < 2) throw new Error('a ring needs at least 2 members');
    for (const m of g.members) {
      if (typeof m !== 'string' || !types[m]) throw new Error(`ring member ${String(m)} is not an agent type`);
      if (m === self) throw new Error('a ring cannot have itself as a member');
    }
    let moderator: RingConfig['moderator'] = null;
    if (g.moderator != null) {
      if (typeof g.moderator.type !== 'string' || !types[g.moderator.type]) throw new Error(`ring moderator ${String(g.moderator.type)} is not an agent type`);
      if (g.moderator.type === self) throw new Error('a ring cannot be its own moderator');
      moderator = { type: g.moderator.type, decides: g.moderator.decides === true };
    }
    if (!Number.isInteger(g.maxRounds) || g.maxRounds < 1) throw new Error('maxRounds must be a whole number, 1 or more');
    ring = { format: g.format, members: [...g.members], moderator, maxRounds: g.maxRounds };
  }
  return { fallback: fb, ring };
}

// The types that name `name` as a fallback, ring member, or moderator.
function dependents(name: string): string[] {
  return Object.entries(agentTypes()).filter(([n, t]) => {
    if (n === name) return false;
    const rv = t.review;
    return rv?.fallback === name || rv?.ring?.members.includes(name) || rv?.ring?.moderator?.type === name;
  }).map(([n]) => n);
}

// Removes a type: a shipped one is masked with null, a user one deleted, and its edited
// instructions go too.
export function removeType(name: string): void {
  if (!agentTypes()[name]) throw new Error(`no agent type ${name}`);
  if (defaultReviewer() === name) throw new Error(`${name} is the default reviewer; make another type the default first`);
  const used = dependents(name);
  if (used.length) throw new Error(`${name} is used by ${used.join(', ')} (fallback, ring member, or moderator); change that first`);
  const user = readUser();
  user.types = { ...user.types };
  if (isShipped(name)) user.types[name] = null;
  else delete user.types[name];
  writeUser(user);
  rmSync(join(STAM_HOME, 'templates', `${typeTemplate(name)}.md`), { force: true });
}

// A harness and the model and effort it runs; a null model or effort is the harness default.
export interface AgentTarget {
  harness: string;
  model: string | null;
  effort: string | null;
}
