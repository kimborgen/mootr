// The Inbox page's rows in the order it shows them (its chip, a search's hits, the groups), kept for
// `advanceInbox`: archiving or deferring the open thread opens the next one in that list (S-2054).
let order: string[] = []
export const setInboxOrder = (ids: string[]) => { order = ids }
export const inboxOrder = (): string[] => order
