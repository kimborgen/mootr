// The Needs you list (S-3831): the asks the human owes an answer, and the ones settled in the last day, from
// GET /api/asks. The daemon sends them in order (open oldest first, then settled newest first); this keeps that
// order, so a row the daemon sent out of place still lands where it belongs. The rail's N is the open count of
// the same list, so the number and the rows never disagree.
import type { Ask } from '../types'

export const isOpenAsk = (a: Ask) => a.state === 'open'

// The rail's N: the open asks the list shows.
export function openAskCount(asks: Ask[]): number {
  return asks.filter(isOpenAsk).length
}

// The rows in the list's order: open asks oldest first, then the settled ones newest first.
export function askRows(asks: Ask[]): Ask[] {
  const open = asks.filter(isOpenAsk).sort((a, b) => a.since.localeCompare(b.since))
  const settled = asks.filter((a) => !isOpenAsk(a)).sort((a, b) => (b.settled_at ?? '').localeCompare(a.settled_at ?? ''))
  return [...open, ...settled]
}

const KIND_LABEL: Record<Ask['kind'], string> = {
  request: 'Permission',
  dialog: 'Harness dialog',
  settings: 'Settings change',
  input: 'Suggested input',
  itsa: 'ITSA',
  decision: 'Decision',
}

export const askKindLabel = (a: Ask): string => KIND_LABEL[a.kind]

// A settled row's outcome, said short: `approved`, `denied`, `answered`.
export const askOutcomeLabel = (a: Ask): string => {
  const o = a.outcome ?? 'settled'
  return o.charAt(0).toUpperCase() + o.slice(1)
}
