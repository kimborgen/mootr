// The state rules of the agent type form (S-412): a reviewer type's review block, the ring, and
// the payload saved to /api/types. Kept apart from the markup so the rules are testable.
export interface Ring { format: string; members: string[]; moderator: { type: string; decides: boolean } | null; maxRounds: number }
export interface Review { fallback: string | null; ring: Ring | null }
export interface TypeDef {
  description?: string; harness: string; model?: string | null; effort?: string | null
  visibility?: { reach?: string } | null; child_notices?: string | null; brief?: string | null
  review?: Review | null
  skills?: string[] | null
}

export const RING_FORMATS = [
  { v: 'rounds', label: 'Rounds', help: 'Members take turns in order, round after round, each reading the others.' },
  { v: 'fire', label: 'Ring of fire', help: 'Every member reviews on its own, then all see all.' },
  { v: 'debate', label: 'Debate', help: 'Members argue the findings back and forth until they agree.' },
]

export const isRing = (t: TypeDef) => Boolean(t.review?.ring)

// A plain type becomes a reviewer with no fallback and no ring; a reviewer type loses its review.
export function setReviewer(t: TypeDef, on: boolean): TypeDef {
  if (on) return t.review ? t : { ...t, review: { fallback: null, ring: null } }
  return { ...t, review: null }
}

// One agent -> Ring hides the harness, model, and effort (a ring type has none). Ring -> One agent
// brings back the harness, model, and effort it had (`prev`), or `harness`.
export interface Target { harness: string; model: string | null; effort: string | null }
export const targetOf = (t: TypeDef): Target => ({ harness: t.harness, model: t.model ?? null, effort: t.effort ?? null })
export function setReviewsAs(t: TypeDef, ring: boolean, others: string[], harness: string, prev: Target | null = null): TypeDef {
  const review = t.review ?? { fallback: null, ring: null }
  if (ring) {
    if (review.ring) return t
    return { ...t, harness: '', model: null, effort: null, review: { ...review, ring: { format: 'rounds', members: others.slice(0, 2), moderator: null, maxRounds: 3 } } }
  }
  if (!review.ring) return t
  return { ...t, ...(prev?.harness ? prev : { harness: t.harness || harness }), review: { ...review, ring: null } }
}

export function patchRing(t: TypeDef, patch: Partial<Ring>): TypeDef {
  const review = t.review
  if (!review?.ring) return t
  return { ...t, review: { ...review, ring: { ...review.ring, ...patch } } }
}

export function moveMember(members: string[], i: number, by: -1 | 1): string[] {
  const j = i + by
  if (j < 0 || j >= members.length) return members
  const out = [...members]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

// The body of POST /api/types/:name. Only a type switched on as the default sends default: true.
export function typePayload(t: TypeDef, isDefault: boolean) {
  const ring = t.review?.ring
  return {
    ...t,
    ...(ring ? { harness: '', model: null, effort: null } : {}),
    visibility: t.visibility?.reach ? t.visibility : null,
    ...(isDefault && t.review ? { default: true } : {}),
  }
}
