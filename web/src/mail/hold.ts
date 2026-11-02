// The threads that led the list as unread (S-4740). A thread opened from the list is read at once, and keeps its row
// while a thread is open, so no row moves while it is read, replied to or archived, and a reply still opens the next
// mail (S-148). The hold ends when the list is shown with no thread open: it sorts by what is unread then. A thread
// that gets new unread mail joins the set and rises.
let held = new Set<string>()
export function holdUnread(unread: Iterable<string>, open: boolean): Set<string> {
  if (!open) held = new Set()
  for (const id of unread) held.add(id)
  return held
}
export const heldUnread = (): ReadonlySet<string> => held
export const resetHeldUnread = () => { held = new Set() }
