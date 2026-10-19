// The compliance matrix's data, free of the store so it can be tested alone: requirements as
// rows, subjects as columns, one cell per pair holding the latest verdict at the requirement's
// current version (what `GET /api/requirements?verdicts=latest` carries), waived ones marked.
// Subjects are either the branches in the merge queue or an ITSA subtree. On a phone the same
// rows become cards with a chip per subject.
import type { Itsa, ItsaQueueRow } from '../types'
import { childrenOf, type LatestVerdict, type Requirement, type Verdict, type WaiverKind } from './model'

export interface MatrixSubject {
  // The column's key: `branch:REPO/NAME` or `itsa:KEY`.
  id: string
  // What the column header says: the branch name, or the ITSA's key.
  label: string
  // Said in full on hover: the ITSA's key and title.
  title: string
  // The ITSA's title alone, without its key: the line under a phone chip.
  name: string
  // The ITSA it belongs to (a queue row's, or the ITSA itself), which its header opens.
  itsaId: string
  // Subject refs that are this subject now: a branch at its head, an ITSA by key or id.
  refs: string[]
  // A branch's verdicts at any head start with this; one at an older head is shown as stale.
  prefix?: string
}

export interface MatrixCell {
  id: number
  verdict: Verdict
  p_violates: number | null
  waived: WaiverKind | null
  // Checked at an older head of the branch, not the one in the queue now.
  stale: boolean
  ts: string
}

export interface MatrixRow {
  req: Requirement
  depth: number
  // By subject id; null where the requirement has no verdict on it at its current version.
  cells: (MatrixCell | null)[]
}

export interface Matrix { subjects: MatrixSubject[]; rows: MatrixRow[] }

// One column per branch in the merge queue, in the queue's order; a branch in two rows once.
export function queueSubjects(rows: Pick<ItsaQueueRow, 'id' | 'key' | 'title' | 'link' | 'facts'>[]): MatrixSubject[] {
  const out: MatrixSubject[] = []
  for (const r of rows) {
    const repo = r.facts?.repo || r.link.repo, branch = r.facts?.branch || r.link.branch
    const id = `branch:${repo}/${branch}`
    if (out.some((s) => s.id === id)) continue
    const head = r.facts?.head
    out.push({ id, label: branch, title: `${branch} · ${r.key} ${r.title}`, name: r.title, itsaId: r.id, refs: head ? [`${id}@${head}`] : [], prefix: `${id}@` })
  }
  return out
}

// One column per ITSA in the subtree under `rootId`, the root first, then depth first in the
// list's order. Closed ITSAs below the root are left out: they are done.
export function subtreeSubjects(itsas: Pick<Itsa, 'id' | 'key' | 'title' | 'parent_id' | 'closed_at'>[], rootId: string): MatrixSubject[] {
  const root = itsas.find((x) => x.id === rootId || x.key === rootId)
  if (!root) return []
  const kids = new Map<string, typeof itsas>()
  for (const x of itsas) if (x.parent_id) kids.set(x.parent_id, [...(kids.get(x.parent_id) ?? []), x])
  const out: MatrixSubject[] = []
  const seen = new Set<string>()
  const visit = (x: (typeof itsas)[number]) => {
    if (seen.has(x.id)) return
    seen.add(x.id)
    out.push({ id: `itsa:${x.key}`, label: x.key, title: `${x.key} ${x.title}`, name: x.title, itsaId: x.id, refs: [`itsa:${x.key}`, `itsa:${x.id}`] })
    for (const c of kids.get(x.id) ?? []) if (!c.closed_at) visit(c)
  }
  visit(root)
  return out
}

// The newest verdict on the subject at the requirement's current version: one on the subject as
// it is now, else, for a branch, one at an older head, marked stale.
export function cellFor(latest: LatestVerdict[] | undefined, s: MatrixSubject): MatrixCell | null {
  const xs = [...(latest ?? [])].sort((a, b) => b.id - a.id)
  const now = xs.find((v) => s.refs.includes(v.subject))
  const hit = now ?? (s.prefix ? xs.find((v) => v.subject.startsWith(s.prefix!)) : undefined)
  return hit ? { id: hit.id, verdict: hit.verdict, p_violates: hit.p_violates, waived: hit.waived, stale: !now, ts: hit.ts } : null
}

// The rows: every requirement but obsolete ones, in tree order (parents before their children),
// with a cell per subject.
export function buildMatrix(reqs: Requirement[], subjects: MatrixSubject[]): Matrix {
  const kids = childrenOf(reqs)
  const rows: MatrixRow[] = []
  const seen = new Set<string>()
  const visit = (x: Requirement, depth: number) => {
    if (seen.has(x.id) || x.status === 'obsolete') return
    seen.add(x.id)
    rows.push({ req: x, depth, cells: subjects.map((s) => cellFor(x.latest, s)) })
    for (const c of kids.get(x.id) ?? []) visit(c, depth + 1)
  }
  for (const x of kids.get(null) ?? []) visit(x, 0)
  return { subjects, rows }
}

// What a cell's glyph and chip show. A waived verdict keeps its verdict's shape, drawn muted.
export type CellState = 'conforms' | 'violates' | 'unsure' | 'na' | 'none'
export const cellState = (c: MatrixCell | null): CellState => (c ? c.verdict : 'none')

// Counts per subject of likely violations not waived, for the column header.
export function flaggedPerSubject(m: Matrix): number[] {
  return m.subjects.map((_, i) => m.rows.reduce((n, r) => n + (r.cells[i] && r.cells[i]!.verdict === 'violates' && !r.cells[i]!.waived && !r.cells[i]!.stale ? 1 : 0), 0))
}
