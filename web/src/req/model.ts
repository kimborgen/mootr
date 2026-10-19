// Requirements in the web UI (S-461), free of the store so it can be
// tested alone: the shapes `/api/requirements` returns, a requirement's conformity from its
// latest verdicts, the tree's roll-up, and how a verdict is worded. A check is only an
// indication, never the truth (Kim): every word here says "likely".
import type { Itsa } from '../types'

export type ReqStatus = 'draft' | 'in_force' | 'suspended' | 'obsolete'
export type Verdict = 'conforms' | 'violates' | 'na' | 'unsure'
export type WaiverKind = 'false_positive' | 'accepted_deviation'

export interface ReqLink { id: number; target_kind: 'itsa' | 'file' | 'test' | 'mail' | 'url' | 'requirement'; target: string; role: string }

// A subject's latest verdict at the requirement's current version (`?verdicts=latest`).
export interface LatestVerdict { id: number; subject: string; verdict: Verdict; p_violates: number | null; waived: WaiverKind | null; ts: string }

export interface Requirement {
  id: string
  key: string
  parent_id: string | null
  level: string | null
  title: string
  text: string | null
  rationale: string | null
  source: string | null
  verification: { method: string; detail?: string }[] | null
  scope: Record<string, string[] | undefined> | null
  severity: 'info' | 'minor' | 'major' | 'critical'
  mode: 'observe' | 'inform' | 'enforce'
  threshold: number
  status: ReqStatus
  owner: string | null
  version: number
  links: ReqLink[]
  latest?: LatestVerdict[]
}

export interface ReqVerdict {
  id: number
  req_version: number
  subject: string
  verdict: Verdict
  p_conforms: number | null
  p_violates: number | null
  p_na: number | null
  ts: string
  waiver?: { kind: WaiverKind; reason: string | null; by: string | null; ts: string } | null
  // The subject said readably (a mail's subject, an ITSA's key and title, a branch's name, the
  // start of a pasted text), and what it opens: a mail its thread, an ITSA itself.
  label?: string
  open?: { kind: 'thread' | 'itsa'; id: string }
}

export interface Precision { window: number; violates: number; false_positives: number; accepted_deviations: number; rate: number | null; max_rate: number }

// GET /api/requirements/:key
export interface RequirementView extends Requirement {
  parent_chain: { id: string; key: string; title: string; status: ReqStatus }[]
  children: Requirement[]
  verdicts: ReqVerdict[]
  precision: Precision
}

export interface PreviewRow { subject: string; summary?: string; verdict?: Verdict; p_violates?: number | null; would_act?: boolean; error?: string }
export interface PreviewResult { key: string; n: number; rows: PreviewRow[]; note?: string }

// The merge queue's line for a branch head (src/itsa-queue.ts Conformity).
export interface ConformityLine { key: string; verdict: Verdict; p_violates: number | null; mode: string; severity: string }
export interface Conformity { checked: boolean; lines: ConformityLine[]; hold: boolean }

// --- Conformity and the roll-up ----------------------------------------------------------

// How a requirement stands: what its glyph and the roll-up bar show.
export type ReqState = 'conforms' | 'violates' | 'unsure' | 'unverified'
export const STATES: ReqState[] = ['conforms', 'violates', 'unsure', 'unverified']
export const STATE_WORD: Record<ReqState, string> = { conforms: 'likely conforms', violates: 'likely violates', unsure: 'unsure', unverified: 'unverified' }

// From the latest verdict per subject at the current version, waived ones left out: any likely
// violation wins, then an unsure one, then a conforming one; with none (or only n/a), unverified.
export function stateOf(latest: LatestVerdict[] | undefined): ReqState {
  const live = (latest ?? []).filter((v) => !v.waived)
  if (live.some((v) => v.verdict === 'violates')) return 'violates'
  if (live.some((v) => v.verdict === 'unsure')) return 'unsure'
  if (live.some((v) => v.verdict === 'conforms')) return 'conforms'
  return 'unverified'
}

export type ReqRollup = Record<ReqState, number>
const empty = (): ReqRollup => ({ conforms: 0, violates: 0, unsure: 0, unverified: 0 })
export const rollupTotal = (r: ReqRollup) => STATES.reduce((n, s) => n + r[s], 0)

// Per requirement, the counts of its subtree, itself included, by state. Only requirements in
// force count: a draft or a suspended one isn't checked as in force, and an obsolete one no
// longer applies (the tree still shows them, with their own glyph). A parent the list doesn't have makes a root, and a
// cycle (which the daemon refuses, but old data might hold) is counted once.
export function rollups(reqs: Requirement[]): Map<string, ReqRollup> {
  const kids = childrenOf(reqs)
  const out = new Map<string, ReqRollup>()
  const visit = (x: Requirement, seen: Set<string>): ReqRollup => {
    const have = out.get(x.id)
    if (have) return have
    const r = empty()
    if (x.status === 'in_force') r[stateOf(x.latest)]++
    seen.add(x.id)
    for (const c of kids.get(x.id) ?? []) {
      if (seen.has(c.id)) continue
      const cr = visit(c, seen)
      for (const s of STATES) r[s] += cr[s]
    }
    out.set(x.id, r)
    return r
  }
  for (const x of reqs) visit(x, new Set())
  return out
}

// Children by parent id (null for the roots), in the list's order.
export function childrenOf(reqs: Requirement[]): Map<string | null, Requirement[]> {
  const ids = new Set(reqs.map((x) => x.id))
  const kids = new Map<string | null, Requirement[]>()
  for (const x of reqs) {
    const p = x.parent_id && ids.has(x.parent_id) ? x.parent_id : null
    kids.set(p, [...(kids.get(p) ?? []), x])
  }
  return kids
}

export function rollupText(r: ReqRollup): string {
  const parts = STATES.filter((s) => r[s]).map((s) => `${r[s]} ${r[s] === 1 ? STATE_WORD[s] : STATE_WORD[s].replace(/s$/, '')}`)
  return parts.length ? parts.join(' · ') : 'nothing in force'
}

// --- Words ---------------------------------------------------------------------------------

export const STATUS_WORD: Record<ReqStatus, string> = { draft: 'draft', in_force: 'in force', suspended: 'suspended', obsolete: 'obsolete' }
const pct = (p: number) => `${Math.round(p * 100)}%`

// A verdict as an indication: "likely violates 91%", never "violates".
export function verdictWord(v: Verdict, p?: number | null): string {
  if (v === 'violates') return `likely violates${p != null ? ' ' + pct(p) : ''}`
  if (v === 'conforms') return 'likely conforms'
  if (v === 'na') return 'likely not applicable'
  return `unsure${p != null ? ' ' + pct(p) : ''}`
}

export const WAIVER_WORD: Record<WaiverKind, string> = { false_positive: 'false positive', accepted_deviation: 'accepted deviation' }

// A verdict's subject, said short when the daemon gave no label: a branch by its name, a pasted
// text never by its hash.
export function subjectLabel(s: string): string {
  const m = /^branch:(?:[^/]+\/)?(.+?)(?:@[0-9a-f]{7,})?$/.exec(s)
  if (m) return m[1]
  if (s.startsWith('text:')) return 'pasted text'
  return s
}
export const verdictLabel = (v: Pick<ReqVerdict, 'subject' | 'label'>) => v.label || subjectLabel(v.subject)

// The merge queue's conformity line: `Merge held · R-7 likely violates 91% · 3 likely conform`.
// Empty while requirements are off.
export function conformityText(c: Conformity | null | undefined): string {
  if (!c) return ''
  if (!c.checked) return 'requirements not checked'
  const bad = c.lines.filter((l) => l.verdict === 'violates').map((l) => `${l.key} ${verdictWord('violates', l.p_violates)}`)
  const unsure = c.lines.filter((l) => l.verdict === 'unsure').length
  const ok = c.lines.filter((l) => l.verdict === 'conforms').length
  const parts = [...(c.hold ? ['Merge held'] : []), ...bad, ...(unsure ? [`${unsure} unsure`] : []), ...(ok ? [`${ok} likely conform${ok === 1 ? 's' : ''}`] : [])]
  return parts.length ? parts.join(' · ') : 'requirements: nothing applies'
}

// --- An ITSA's requirements ----------------------------------------------------------------

export interface ItsaReqRow { req: Requirement; role: string; verdict: LatestVerdict | null }

// The requirements linked to an ITSA (a link to its key or id), each with its latest verdict on
// the ITSA itself (`itsa:KEY`), waived or not.
export function linkedTo(it: Pick<Itsa, 'id' | 'key'>, reqs: Requirement[]): ItsaReqRow[] {
  const rows: ItsaReqRow[] = []
  for (const r of reqs) {
    const l = r.links.find((x) => x.target_kind === 'itsa' && (x.target === it.key || x.target === it.id))
    if (!l) continue
    const verdict = (r.latest ?? []).find((v) => v.subject === `itsa:${it.key}` || v.subject === `itsa:${it.id}`) ?? null
    rows.push({ req: r, role: l.role, verdict })
  }
  return rows.sort((a, b) => a.req.key.localeCompare(b.req.key, undefined, { numeric: true }))
}
