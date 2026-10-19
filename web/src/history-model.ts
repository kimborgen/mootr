// The sidebar history's list (S-1456), as plain data. One entry per thing shown in main (an agent,
// a thread, an issue, a page), kept oldest first; the marker is the entry showing. `pos` is the
// entry's place in the browser's own history (nav-history.ts counts it), so a click on a row can
// move there with history.go(), the same as pressing back or forward that many times. The list
// is the browser history seen by thing, so there is no second history to disagree with it.
export interface HEntry { key: string; pos: number }
export interface HistoryState { entries: HEntry[]; marker: number }

export const HISTORY_MAX = 50
export const emptyHistory = (): HistoryState => ({ entries: [], marker: -1 })

// A thing is shown at browser position `pos`. The same thing as the marker's updates that entry in
// place (its view mode, Settings section or Usage tab changed); another thing prunes the entries
// above the marker, then goes on top. Past HISTORY_MAX the oldest entry goes.
export function visit(s: HistoryState, key: string, pos: number): HistoryState {
  const at = s.entries[s.marker]
  if (at && at.key === key) return at.pos === pos ? s : { ...s, entries: s.entries.map((e, i) => (i === s.marker ? { key, pos } : e)) }
  const kept = [...s.entries.slice(0, s.marker + 1), { key, pos }]
  const entries = kept.slice(-HISTORY_MAX)
  return { entries, marker: entries.length - 1 }
}

// The browser pushed a new entry at `pos`, which drops every entry after the current one. Entries
// at or past `pos` are gone from the browser's history, so they leave the list too, whatever the
// push was (a new thing, a view change, an overlay); the marker follows to the last one left.
export function drop(s: HistoryState, pos: number): HistoryState {
  const entries = s.entries.filter((e) => e.pos < pos)
  return entries.length === s.entries.length ? s : { entries, marker: Math.min(s.marker, entries.length - 1) }
}

// The browser moved to position `pos`, showing `key` (back, forward, or a row's jump). The marker
// goes to the entry of that thing nearest the position. A thing the list doesn't hold (it fell off
// the cap, or the page was reloaded) goes at the bottom when it is older than all (the newest entry goes if that passes the cap), else it is a visit.
export function settle(s: HistoryState, key: string, pos: number): HistoryState {
  let best = -1
  s.entries.forEach((e, i) => {
    if (e.key === key && (best < 0 || Math.abs(e.pos - pos) < Math.abs(s.entries[best].pos - pos))) best = i
  })
  if (best < 0) {
    if (s.entries.length && pos < s.entries[0].pos) return { entries: [{ key, pos }, ...s.entries].slice(0, HISTORY_MAX), marker: 0 }
    return visit(s, key, pos)
  }
  const entries = s.entries[best].pos === pos ? s.entries : s.entries.map((e, i) => (i === best ? { key, pos } : e))
  return best === s.marker && entries === s.entries ? s : { entries, marker: best }
}

// The entry `d` steps from the marker (-1 older, +1 newer) that is alive, skipping dead ones; -1 if none.
export function step(s: HistoryState, d: -1 | 1, alive: (key: string) => boolean, from = s.marker): number {
  for (let i = from + d; i >= 0 && i < s.entries.length; i += d) if (alive(s.entries[i].key)) return i
  return -1
}

// Back or forward landed on `key` at browser position `to`, from `pos`, and that thing is dead.
// With a live entry further the same way, the delta (from `to`) that reaches it; null means show
// the target as it is, its gone state: the list doesn't hold it, or nothing live lies that way.
export function skipDead(s: HistoryState, key: string, to: number, pos: number, alive: (key: string) => boolean): number | null {
  let at = -1
  s.entries.forEach((e, i) => {
    if (e.key === key && (at < 0 || Math.abs(e.pos - to) < Math.abs(s.entries[at].pos - to))) at = i
  })
  if (at < 0) return null
  const j = step(s, to < pos ? -1 : 1, alive, at)
  return j < 0 ? null : s.entries[j].pos - to
}
