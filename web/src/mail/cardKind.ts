// What kind of card a thread is (S-1310): the one classifier the swipe cards share. A thread that
// waits on the human (a pending permission, an open decision block, an ITSA ask) is a decision;
// otherwise the mail check's verdict kind says: decision, blocker, done, anything else general.
// Pure: the caller reads the store and passes what it found, so it tests without a DOM.
export type CardKind = 'decision' | 'blocker' | 'done' | 'general'

export interface CardKindInput {
  // A pending permission on the thread, an open decision block for it, or an ITSA ask on it.
  waiting: boolean
  // The card mail's `verdict.kind` from the mail check; null or absent when unchecked.
  verdictKind?: string | null
}

export function cardKind({ waiting, verdictKind }: CardKindInput): CardKind {
  if (waiting) return 'decision'
  if (verdictKind === 'decision' || verdictKind === 'blocker' || verdictKind === 'done') return verdictKind
  return 'general'
}
