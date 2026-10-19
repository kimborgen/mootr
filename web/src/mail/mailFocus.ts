// A mail link can name one mail in a thread (S-415). The link asks for that mail here, with the
// thread that holds it; the thread opens the mail, scrolls it below the sticky header, and
// highlights it. The ask ends once its thread has loaded, or when the user goes to another view, so a
// later thread never takes it.
export interface Focus { id: string; tid: string }
let wanted: Focus | null = null
const listeners = new Set<() => void>()

export function askFocus(id: string, tid: string): void {
  wanted = { id, tid }
  for (const l of listeners) l()
}
export const pendingFocus = (): Focus | null => wanted
export const doneFocus = (): void => { wanted = null }
// Calls fn after each ask, so a thread already on screen can act on it.
export function onFocus(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// The mail the ask names, when the thread shown is the one it names and holds that mail.
export function focusIn(threadKey: string, mailIds: string[]): string | null {
  return wanted && wanted.tid === threadKey && mailIds.includes(wanted.id) ? wanted.id : null
}
// Called once a thread has loaded: the ask ends, whether or not the thread holds the mail. Returns
// the mail to open, if the ask named this thread and the thread holds it.
export function settleFocus(threadKey: string, mailIds: string[]): string | null {
  if (!wanted || wanted.tid !== threadKey || !mailIds.length) return null
  const id = focusIn(threadKey, mailIds)
  doneFocus()
  return id
}

// The scroll top that puts a mail's top edge just under the header: rowTop is the mail's top
// relative to the scroll box's top, headHeight is 0 when the header scrolls away with the mails,
// and gap is the mail's scroll margin.
export function focusScrollTop(rowTop: number, scrollTop: number, headHeight: number, gap: number): number {
  return Math.max(0, scrollTop + rowTop - headHeight - gap)
}

// Where a thread starts when it opens (S-1500): the bottom, so the latest message is in view. A latest
// message taller than the box starts at its own top (under the header, `gap`), so its first lines show.
// lastTop is the latest row's top in the box's scrolled content, lastHeight its height, and gap the sticky header's
// height plus the row's scroll margin (0 where the header scrolls away).
export function openScrollTop(lastTop: number, lastHeight: number, scrollHeight: number, clientHeight: number, gap = 0): number {
  if (lastHeight > clientHeight - gap) return Math.max(0, lastTop - gap)
  return Math.max(0, scrollHeight - clientHeight)
}
