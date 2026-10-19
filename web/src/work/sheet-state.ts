// Whether the phone's sort and filter sheet (filter-sheet.tsx) is open, kept outside the component so
// the browser history can see it (nav-history.ts): a back press closes the sheet instead of leaving Work.
let open = false
const ls = new Set<() => void>()
export const workSheetOpen = () => open
export function setWorkSheet(on: boolean) { if (on === open) return; open = on; for (const f of ls) f() }
export function onWorkSheetChange(fn: () => void) { ls.add(fn); return () => { ls.delete(fn) } }
