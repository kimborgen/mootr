// cc pills (S-1464): every normal prompt input asks /api/suggest as the human types, as the Alt+A
// prompt does, and shows the few best items as pills on the box's top border. A pick only adds a
// cc: an agent gets the mail, a thread's participants get it, an ITSA has the mail filed on it.
import type { SearchResult } from './types'

// The least score a pill needs. Higher than the Alt+A prompt's, which shows anything at the
// server's SUGGEST_FLOOR (0.35): a box the human didn't open to be routed suggests only near matches.
export const CC_FLOOR = 0.5
// At most this many pills show at once.
export const CC_PILLS = 3

// A thread or ITSA picked as a cc. `people`: the agents a thread's cc mails, resolved at the pick.
export interface CcItem { kind: 'thread' | 'itsa'; id: string; title: string; people: string[] }

// What the box already sends to, so no pill repeats it: the recipient, the agent cc, the picked items.
export interface CcTaken { to?: string; cc: string[]; items: CcItem[] }

// The pills for a set of suggestions: near enough, of a kind a cc can be, not already taken, best first.
// `ok` says whether an agent can be cc'd (one this page knows and that is live).
export function ccPills(rs: SearchResult[], taken: CcTaken, ok: (agent: string) => boolean = () => true): SearchResult[] {
  const out: SearchResult[] = []
  for (const r of rs) {
    if (r.score < CC_FLOOR) continue
    if (r.kind === 'agent' ? r.id === taken.to || taken.cc.includes(r.id) || !ok(r.id)
      : r.kind === 'thread' || r.kind === 'itsa' ? taken.items.some((x) => x.kind === r.kind && x.id === r.id) : true) continue
    out.push(r)
    if (out.length === CC_PILLS) break
  }
  return out
}

// Adds a picked item. A mail is filed on one ITSA, so a second ITSA replaces the first.
export const addItem = (items: CcItem[], x: CcItem): CcItem[] =>
  [...items.filter((y) => !(y.kind === x.kind && y.id === x.id) && !(x.kind === 'itsa' && y.kind === 'itsa')), x]

// What a send carries for its cc: the agent ids, with each picked thread's participants, once each;
// and the ITSA it is filed on.
export function ccPayload(cc: string[], items: CcItem[], to?: string): { cc: string[]; itsa?: string } {
  const all = [...new Set([...cc, ...items.flatMap((x) => x.people)])].filter((id) => id !== to)
  const itsa = items.find((x) => x.kind === 'itsa')?.id
  return itsa ? { cc: all, itsa } : { cc: all }
}
