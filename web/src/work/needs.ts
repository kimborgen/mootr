// The Work page's pinned "Needs you" group, free of the store so it can be tested alone: one
// row per thing waiting on the human, plus each ready_to_merge ITSA in the merge queue. The
// waiting rows come from `useWaiting` (itsa/WaitingList), the one definition the Issues header
// count, the mail list's pinned list, and this group share, so the three always agree. The
// queue rows come from `GET /api/itsas/queue`. Oldest first, as the waiting list orders them,
// with the merge queue by the ITSA's last change.
import type { Agent, BranchFacts, Itsa, ItsaAction, ItsaQueueRow, Permission } from '../types'
import type { WaitingRow } from '../itsa/WaitingList'
import { conformityText } from '../req/model'

export type NeedsKind = 'itsa' | 'perm' | 'wait' | 'merge'

export interface NeedsRow {
  kind: NeedsKind
  // A stable row key: the waiting row's (`i:`/`p:`/`w:`), or `q:<id>:<link n>` for a queue row.
  key: string
  since: string
  // What the Work columns render: the real ITSA, or a stand-in carrying the row's own fields.
  it: Itsa
  // The ITSA's id when the row is about one (an attention ITSA or a queue row), so the tree
  // can mark the same ITSA too. Null for a permission request or an agent's human wait.
  itsaId: string | null
  // The ITSA's actions (attention rows); empty for every other kind.
  actions: ItsaAction[]
  perm: Permission | null
  agent: Agent | null
  queue: ItsaQueueRow | null
  // For a permission request or a human wait: the mail thread to open, else null.
  threadId: string | null
}

// The fields the Work columns read, so a permission request or an agent's human wait (which
// are not ITSAs) can stand in for one.
interface Subject {
  id: string
  key: string
  title: string
  summary?: string | null
  status: string
  owner: string | null
  updated_at: string
}

function standIn(x: Subject): Itsa {
  return {
    id: x.id, key: x.key, parent_id: null, kind: null, title: x.title, summary: x.summary ?? null, body: null,
    status: x.status, owner: x.owner, thread_id: null, created_by: '', created_at: x.updated_at, updated_at: x.updated_at, closed_at: null,
  }
}

// A permission request or an agent's human wait, as a stand-in ITSA: its status is the human
// status that fits (a request asks approval, a reply waits for input), so the Status cell
// carries the same warning tone the waiting list's mark does.
function waitingSubject(w: WaitingRow): Itsa {
  return standIn({
    id: w.perm ? `perm:${w.perm.id}` : `wait:${w.key}`,
    key: '',
    title: w.what,
    summary: w.perm?.reason ?? null,
    status: w.perm ? 'needs_approval' : 'needs_input',
    owner: w.agent?.id ?? null,
    updated_at: w.since,
  })
}

// Merge the waiting rows with the merge queue, oldest first. A queue row whose ITSA is already
// a waiting row is dropped, so one ITSA never appears twice (a permission request is already
// one row: `useWaiting` folds an agent's human wait for it into a single row).
export function needsRows(waiting: WaitingRow[], queue: ItsaQueueRow[]): NeedsRow[] {
  const rows: NeedsRow[] = waiting.map((w) => ({
    kind: w.itsa ? 'itsa' : w.perm ? 'perm' : 'wait',
    key: w.key,
    since: w.since,
    it: w.itsa ?? waitingSubject(w),
    itsaId: w.itsa?.id ?? null,
    actions: w.itsa?.actions ?? [],
    perm: w.perm ?? null,
    agent: w.agent ?? null,
    queue: null,
    threadId: w.threadId ?? null,
  }))
  const have = new Set(rows.map((r) => r.itsaId).filter((id): id is string => !!id))
  for (const q of queue) {
    if (have.has(q.id)) continue
    rows.push({
      kind: 'merge',
      key: `q:${q.id}:${q.link.n}`,
      since: q.updated_at,
      it: standIn({ id: q.id, key: q.key, title: q.title, summary: [factLine(q.facts), conformityText(q.conformity)].filter(Boolean).join(' · '), status: 'ready_to_merge', owner: q.owner, updated_at: q.updated_at }),
      itsaId: q.id,
      actions: [],
      perm: null,
      agent: null,
      queue: q,
      threadId: null,
    })
  }
  return rows.sort((a, b) => a.since.localeCompare(b.since))
}

// A branch's facts said short: `+412 −38 · merges cleanly · 3 behind main`. An unreadable
// branch says why instead.
export function factLine(f: BranchFacts): string {
  if (f.error) return f.error
  const parts: string[] = []
  if (f.diff) parts.push(`+${f.diff.insertions} −${f.diff.deletions}`)
  if (f.mergeable === true) parts.push('merges cleanly')
  else if (f.mergeable === false) parts.push('conflicts')
  if (f.behind) parts.push(`${f.behind} behind main`)
  return parts.join(' · ')
}

// The ITSAs whose tree rows also get the attention bar, from the group's rows.
export function attentionItsaIds(rows: NeedsRow[]): Set<string> {
  return new Set(rows.map((r) => r.itsaId).filter((id): id is string => !!id))
}
