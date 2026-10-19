// Whether a long-press just opened the cell menu (S-1518). The finger lifting after it can still fire a click on the link
// under it; a link chip reads this to let that click do nothing instead of opening its target under the menu (S-1533).
// It expires: where no lift click follows (Android), a later tap must not be taken for it.
export const PRESS_MS = 1000
let at = -Infinity
export const markPress = (): void => { at = Date.now() }
// The finger lifting restarts the window: a hold longer than PRESS_MS after the menu opened still has its lift click taken.
export const refreshPress = (): void => { if (at > -Infinity) at = Date.now() }
export const clearPress = (): void => { at = -Infinity }
// True once for the click that ends a long-press, if it comes within PRESS_MS.
export const takePress = (): boolean => { const f = Date.now() - at < PRESS_MS; at = -Infinity; return f }
