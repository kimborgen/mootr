// The count badge on a process node. A node carries a badge only when it has `statuses` (the
// nodes ITSAs can sit in); a count of 0 shows muted, because a stage is a stage even when it is
// empty. Pure, so the view and its test agree on the formatting.
import type { ProcessCount, ProcessNode } from './types'

export interface CountBadge {
  text: string
  // No ITSAs sit here: the badge is muted rather than coloured.
  muted: boolean
}

// A count as a badge: undefined means zero (a node with statuses but no entry shows "0").
export function countBadge(count: number | undefined): CountBadge {
  const n = count ?? 0
  return { text: String(n), muted: n === 0 }
}

// The badge for a node, or null when it should show none: a node without statuses never does.
export function nodeBadge(node: ProcessNode, count: number | undefined): CountBadge | null {
  if (!node.statuses?.length) return null
  return countBadge(count)
}

// The badge for a node id against a process's counts map.
export function badgeFor(id: string, node: ProcessNode, counts: Record<string, ProcessCount> | undefined): CountBadge | null {
  return nodeBadge(node, counts?.[id]?.count)
}
