// A pick block the human leaves untouched (S-1516): its recommended options are ticked already, so a reply sent
// without touching it means "as suggested". This lists those blocks in the open messages of a thread panel, so the
// reply says so instead of leaving the block out. A block that is answered or deferred, and a mail between agents or
// superseded, is left alone. `taken` says whether a block already has a staged answer.
import { questionOf } from './mailblocks'

export interface SuggestedPick { mailId: string; key: string; q: string; labels: string[] }

export function suggestedPicks(panel: ParentNode, taken: (key: string) => boolean): SuggestedPick[] {
  const out: SuggestedPick[] = []
  for (const art of panel.querySelectorAll<HTMLElement>('.msg.open:not(.between):not(.superseded)')) {
    for (const b of art.querySelectorAll<HTMLElement>('.mb-decision.multi:not(.answered):not(.deferred)')) {
      const key = `${art.dataset.id}:${b.dataset.decision}`
      if (taken(key)) continue
      const labels = [...b.querySelectorAll<HTMLElement>('[data-choose].sel')].map((o) => o.dataset.choose!)
      if (labels.length) out.push({ mailId: art.dataset.id!, key, q: questionOf(b), labels })
    }
  }
  return out
}
