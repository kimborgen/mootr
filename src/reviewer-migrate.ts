// `stam registry migrate-reviewers [--apply]` (S-412): turns the reviewer setting of S-360
// (settings.agentTypes.reviewer) into agent types in the user's registry.json, then drops
// the key from settings.json. Home only; no daemon needed (a running home pushes the new
// registry to peers on their next poll, since this process can't tell it). A dry run prints the plan.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAM_HOME } from './config.ts';
import { isSettingsHome, settings as currentSettings } from './settings.ts';
import { agentTypes, fallbackChain, saveType, setDefaultReviewer, type AgentTarget, type AgentType } from './agent-types.ts';

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

// A target with a harness; a model or effort that isn't a non-empty string is null.
function targetOf(u: any): AgentTarget | null {
  if (!isObj(u) || typeof u.harness !== 'string' || !u.harness) return null;
  return {
    harness: u.harness,
    model: typeof u.model === 'string' && u.model ? u.model : null,
    effort: typeof u.effort === 'string' && u.effort ? u.effort : null,
  };
}
const same = (a: AgentTarget, b: { harness: string; model: string | null; effort: string | null }) => a.harness === b.harness && a.model === b.model && a.effort === b.effort;
const tag = (t: AgentTarget) => `${t.harness}${t.model ? ` ${t.model}` : ''}${t.effort ? ` (${t.effort})` : ''}`;

export interface TypeChange {
  name: string;
  input: Record<string, any>;
  why: string;
}
export interface ReviewerMigration {
  changes: TypeChange[];
  defaultReviewer: string | null;
  // Set when the old value can't be carried over; nothing is applied and settings are kept.
  error?: string;
}

// The registry changes that reproduce a saved S-360 reviewer setting, given the types now in
// the registry (the shipped ones, with `reviewer` and `reviewer-opus`). Each type is listed
// after the types it names, so saving in order validates. An absent or all-default value
// changes nothing.
export function reviewerMigration(old: unknown, types: Record<string, AgentType> = agentTypes()): ReviewerMigration {
  const out: ReviewerMigration = { changes: [], defaultReviewer: null };
  if (!isObj(old) || !isObj(old.reviewer)) return out;
  const r = old.reviewer;
  const base = types.reviewer;
  if (!base) return { ...out, error: 'the reviewer type is removed from the registry (masked in registry.json); restore it, then run this again' };
  const primary = targetOf(r.primary) ?? { harness: base.harness, model: base.model, effort: base.effort };
  const noFallback = r.fallback === null || r.fallback === false;
  const fallback = noFallback ? null : targetOf(r.fallback);
  const taken = new Set(Object.keys(types));
  const fresh = (name: string) => {
    let n = name;
    for (let i = 2; taken.has(n); i++) n = `${name}-${i}`;
    taken.add(n);
    return n;
  };
  // An existing reviewer type with this target (not `reviewer` itself, nor one that falls back to it).
  const existing = (t: AgentTarget) =>
    Object.entries(types).find(([n, x]) => n !== 'reviewer' && x.review && !x.review.ring && same(t, x) && !fallbackChain(n).includes('reviewer'))?.[0];
  const brief = base.brief;

  // The fallback: the saved target mapped to an existing reviewer type with the same harness, model,
  // and effort (Opus medium is the shipped reviewer-opus); null is none; else a new type.
  let fallbackType: string | null = 'reviewer-opus';
  if (noFallback) fallbackType = null;
  else if (fallback && existing(fallback)) fallbackType = existing(fallback)!;
  else if (fallback) {
    fallbackType = fresh('reviewer-fallback');
    out.changes.push({ name: fallbackType, why: `the saved fallback, ${tag(fallback)}`, input: { description: 'Backup reviewer when the primary reviewer\'s window runs low (migrated from settings).', ...fallback, brief, review: { fallback: null, ring: null } } });
  }
  const primaryChanged = !same(primary, base);
  if (primaryChanged || fallbackType !== base.review?.fallback) {
    out.changes.push({ name: 'reviewer', why: [primaryChanged ? `primary becomes ${tag(primary)}` : '', fallbackType !== base.review?.fallback ? `falls back to ${fallbackType ?? 'nothing'}` : ''].filter(Boolean).join(', '), input: { ...base, ...primary, review: { fallback: fallbackType, ring: null } } });
  }

  // Ring members are matched against the types as they are after the changes above, so a member
  // never resolves to a changed `reviewer`.
  const effective: Record<string, AgentType> = { ...types };
  for (const c of out.changes) effective[c.name] = c.input as AgentType;

  // A ring, or several models: a ring type of one type per model, set as the default.
  const models = (Array.isArray(r.models) ? r.models : []).flatMap((m: unknown) => targetOf(m) ?? []);
  if ((r.process === 'ring' || r.process === 'models') && models.length >= 2) {
    const members = models.map((m, i) => {
      const [shipped] = Object.entries(effective).filter(([, t]) => t.review && !t.review.ring && t.harness === m.harness && t.model === m.model && t.effort === m.effort).map(([n]) => n);
      if (shipped) return shipped;
      const name = fresh(`reviewer-ring-${i + 1}`);
      out.changes.push({ name, why: `ring member ${tag(m)}`, input: { description: `Ring member ${tag(m)} (migrated from settings).`, ...m, brief, review: { fallback: null, ring: null } } });
      return name;
    });
    const format = ['rounds', 'fire', 'debate'].includes(r.ring?.format) ? r.ring.format : 'rounds';
    const maxRounds = Number.isInteger(r.ring?.maxRounds) && r.ring.maxRounds >= 1 ? r.ring.maxRounds : 3;
    const name = fresh('reviewer-ring-migrated');
    out.changes.push({ name, why: `the saved ${r.process} review of ${models.length} models`, input: { description: 'Ring review migrated from settings: the saved models review in turns.', harness: '', review: { fallback: 'reviewer', ring: { format, members, moderator: null, maxRounds } } } });
    out.defaultReviewer = name;
  }
  return out;
}

export function runMigrateReviewers(apply: boolean): { code: number; text: string } {
  // The registry lives on the settings home (S-387): a peer neither writes it nor reads a plan for it.
  if (!isSettingsHome()) return { code: 1, text: `Not migrated: the registry and settings live on ${currentSettings().home}; run this there.` };
  const file = join(STAM_HOME, 'settings.json');
  let settings: any = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      return { code: 1, text: `settings.json is not valid JSON: ${e instanceof Error ? e.message : e}` };
    }
  }
  if (!isObj(settings) || !('agentTypes' in settings)) return { code: 0, text: 'No agentTypes in settings.json; nothing to migrate.' };
  const plan = reviewerMigration(settings.agentTypes);
  if (plan.error) return { code: 1, text: `Not migrated: ${plan.error}.` };
  const lines = plan.changes.map((c) => `  type ${c.name}: ${c.why}`);
  if (plan.defaultReviewer) lines.push(`  default reviewer: ${plan.defaultReviewer}`);
  lines.push('  drop agentTypes from settings.json');
  if (!apply) return { code: 0, text: `Would change (run with --apply):\n${lines.join('\n')}` };
  for (const c of plan.changes) saveType(c.name, c.input);
  if (plan.defaultReviewer) setDefaultReviewer(plan.defaultReviewer);
  delete settings.agentTypes;
  writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return { code: 0, text: `Changed:\n${lines.join('\n')}` };
}
