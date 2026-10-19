// Short names (S-572): at the fit zoom a cut name doesn't tell siblings apart ("waitin…" four
// times), so a card's chip, its name row in Cards, and its star label drop the words it shares
// with its parent's name: "system-view-dev3" under "system-view" shows "dev3", and "cost-review"
// under "cost" shows "review". Words split at -, _, . and spaces, so a cut never falls inside one.
// The panel, the titles and the labels for assistive tech keep the full name.
const WORD = /[^-_. ]+|[-_. ]+/g

export function shortName(name: string, parent: string | null | undefined): string {
  if (!parent) return name
  const own = name.match(WORD) ?? []
  const theirs = (parent.match(WORD) ?? []).filter((w) => !/^[-_. ]+$/.test(w))
  // Walk the words they share, from the start, at whole words.
  let i = 0, shared = 0
  while (i < own.length && shared < theirs.length && own[i].toLowerCase() === theirs[shared].toLowerCase()) {
    shared++
    i++
    // Past the separator after the shared word.
    if (i < own.length && /^[-_. ]+$/.test(own[i])) i++
    else break
  }
  const rest = own.slice(i).join('')
  // Nothing shared, or nothing left that is a word of its own: the full name.
  return shared && /[^-_. ]/.test(rest) ? rest : name
}
