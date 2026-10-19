// Agent types for filtering (S-1444, reworked S-1491): the registry `type` of an agent, which Usage › Activity
// and Agents filter by, so a cost or time number can leave out the chief of staff or show only developers.
// Computed here on the daemon; the web only toggles the names (web/src/usage/agentFilter.ts).
import { agentTypes, isReviewerType } from './agent-types.ts';

// Agents without a registry type (or with one the registry no longer has) are named by their role; the rest are `untyped`.
export const ROLE_TYPES = ['chief-of-staff', 'assistant', 'intake', 'untyped'] as const;

// The standing intake agent has the name `intake` and no type. The one place the rule lives.
export const isIntake = (a: { name: string; type: string | null }): boolean => a.name === 'intake' && !a.type;

// `cosId` is `settings().chiefOfStaff`: the configured id or name, also when that agent is archived or paused. The
// chief of staff is its own type whatever its registry type, so it can be left out of a number on its own.
export function typeOf(a: { id: string; name: string; type: string | null; kind?: string | null }, cosId: string | null): string {
  if (cosId && (a.id === cosId || a.name === cosId)) return 'chief-of-staff';
  if (a.type && a.type in agentTypes()) return a.type;
  if (a.kind === 'assistant') return 'assistant';
  if (isIntake(a)) return 'intake';
  return 'untyped';
}

// Every name `agents=` takes: the registry's types and the role names.
export const knownTypes = (): string[] => [...Object.keys(agentTypes()), ...ROLE_TYPES.filter((r) => !(r in agentTypes()))];

// Before S-1491 the filter was a preset, or a `+class,-class` list over coarse classes. Links and daemons
// still send those; each maps to the type set it meant.
const LEGACY_CLASS = ['cos', 'assistant', 'intake', 'manager', 'developer', 'reviewer', 'advisor', 'other'];
function legacyClassTypes(c: string): string[] {
  const reg = Object.keys(agentTypes());
  const reviewers = reg.filter(isReviewerType);
  const named = new Set(['manager', 'coordinator', 'developer', 'advisor', ...reviewers]);
  switch (c) {
    case 'cos': return ['chief-of-staff'];
    case 'assistant': case 'intake': case 'developer': case 'advisor': return [c];
    case 'manager': return ['manager', 'coordinator'];
    case 'reviewer': return reviewers;
    default: return ['untyped', ...reg.filter((t) => !named.has(t))];
  }
}
const legacyAll = (): string[] => [...new Set(LEGACY_CLASS.flatMap(legacyClassTypes))];
const legacyWork = (): string[] => legacyAll().filter((t) => !['chief-of-staff', 'assistant', 'intake'].includes(t));
const LEGACY_PRESET: Record<string, () => string[]> = {
  work: legacyWork,
  managers: () => ['manager', 'coordinator'],
  developers: () => ['developer'],
  'non-managers': () => legacyWork().filter((t) => t !== 'manager' && t !== 'coordinator'),
};

// The types an `agents=` value keeps: a comma list of type names, or an older preset name or `+class,-class`
// list (mapped to its types). Null for no filter (empty, `all`); throws on an unknown name so the caller can
// answer 400.
export function parseAgentFilter(raw: string | null | undefined): Set<string> | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v || v === 'all') return null;
  if (LEGACY_PRESET[v]) return new Set(LEGACY_PRESET[v]());
  const parts = v.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => p[0] === '+' || p[0] === '-')) {
    const plus: string[] = [];
    const minus: string[] = [];
    for (const p of parts) {
      const sign = p[0];
      const name = p.slice(1);
      if ((sign !== '+' && sign !== '-') || !LEGACY_CLASS.includes(name)) throw new Error(`agents must be a comma list of agent types (${knownTypes().join(', ')}), not ${raw}`);
      (sign === '+' ? plus : minus).push(...legacyClassTypes(name));
    }
    const keep = new Set(plus.length ? plus : legacyAll());
    for (const t of minus) keep.delete(t);
    return keep;
  }
  const known = new Set(knownTypes());
  for (const p of parts) if (!known.has(p)) throw new Error(`agents must be a comma list of agent types (${knownTypes().join(', ')}), not ${raw}`);
  return new Set(parts);
}

// The filter as one stable string (the types kept, sorted): the summary cache key and the answer's label.
export const filterKey = (keep: Set<string> | null): string => (keep ? [...keep].sort().join(',') || 'none' : '');
