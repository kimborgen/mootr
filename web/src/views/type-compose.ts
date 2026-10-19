// The rules of the type composer (S-892): a draft of a type's `blocks` (off, replace, order) over the
// catalog of blocks the composing templates offer, and the payload it saves. Kept apart from the
// markup so the rules are testable.
export interface CBlock { id: string; title: string; summary: string; tokens: number; template: string; rendered: boolean; applies: boolean }
export interface CRep { path: string; id: string; title: string; summary: string; tokens: number }
export interface Catalog { blocks: CBlock[]; replacements: CRep[] }
export interface TypeBlocks { off?: string[]; replace?: Record<string, string>; order?: string[] }
export interface Draft { off: string[]; replace: Record<string, string>; order: string[] }

// The block ids of the catalog in the order a render gives them: per template, the ids the order lists
// first, in that order, then the rest in the template's own order (the same rule as composedBlocks).
export function orderedIds(cat: Catalog, order: string[] = []): string[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  const out: string[] = []
  for (const t of new Set(cat.blocks.map((b) => b.template))) {
    const group = cat.blocks.filter((b) => b.template === t)
    out.push(...[...group].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || 0).map((b) => b.id))
  }
  return out
}

export function draftOf(saved: TypeBlocks | null | undefined, cat: Catalog): Draft {
  const known = new Set(cat.blocks.map((b) => b.id))
  const replace = Object.fromEntries(Object.entries(saved?.replace ?? {}).filter(([id]) => known.has(id)))
  return { off: (saved?.off ?? []).filter((id) => known.has(id)), replace, order: orderedIds(cat, saved?.order) }
}

// Switching a block off drops its replacement: a block is never both.
export function setOff(d: Draft, id: string, off: boolean): Draft {
  const rest = d.off.filter((x) => x !== id)
  const replace = { ...d.replace }
  if (off) delete replace[id]
  return { ...d, off: off ? [...rest, id] : rest, replace }
}

export function setReplacement(d: Draft, id: string, path: string): Draft {
  const replace = { ...d.replace }
  if (path) replace[id] = path
  else delete replace[id]
  return { ...d, replace, off: d.off.filter((x) => x !== id) }
}

// Moves a block one place up or down within its template; the first and last stay put.
export function moveBlock(d: Draft, cat: Catalog, id: string, by: -1 | 1): Draft {
  const t = cat.blocks.find((b) => b.id === id)?.template
  const group = d.order.filter((x) => cat.blocks.find((b) => b.id === x)?.template === t)
  const i = group.indexOf(id)
  const j = i + by
  if (i < 0 || j < 0 || j >= group.length) return d
  ;[group[i], group[j]] = [group[j], group[i]]
  const queue = [...group]
  return { ...d, order: d.order.map((x) => (cat.blocks.find((b) => b.id === x)?.template === t ? queue.shift()! : x)) }
}

// Estimated tokens the composing templates add for a draft, counting only the templates the agent gets
// (it gets one of the two mail-rule templates, by its model). The page shows the inventory's total
// plus the difference to the saved draft.
export function composing(cat: Catalog, d: Draft): number {
  const rep = new Map(cat.replacements.map((r) => [r.path, r.tokens]))
  return cat.blocks.reduce((n, b) => (!b.rendered || !b.applies || d.off.includes(b.id) ? n : n + (rep.get(d.replace[b.id]) ?? b.tokens)), 0)
}
export const totalFor = (inventoryTotal: number, cat: Catalog, saved: Draft, draft: Draft) => inventoryTotal + composing(cat, draft) - composing(cat, saved)

// The `blocks` of the saved type: only what differs from the global templates; undefined when nothing.
export function blocksPayload(cat: Catalog, d: Draft): TypeBlocks | undefined {
  const out: TypeBlocks = {}
  const ids = new Set(cat.blocks.map((b) => b.id))
  const off = d.off.filter((id) => ids.has(id))
  if (off.length) out.off = off
  const replace = Object.fromEntries(Object.entries(d.replace).filter(([id]) => ids.has(id) && !off.includes(id)))
  if (Object.keys(replace).length) out.replace = replace
  if (d.order.join() !== orderedIds(cat).join()) out.order = d.order
  return out.off || out.replace || out.order ? out : undefined
}

export const sameDraft = (a: Draft, b: Draft) => JSON.stringify([[...a.off].sort(), Object.entries(a.replace).sort(), a.order]) === JSON.stringify([[...b.off].sort(), Object.entries(b.replace).sort(), b.order])
