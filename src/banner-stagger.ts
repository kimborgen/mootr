// Which panes a banners tick captures (S-349, daemon.ts dismissBanners). Every pane due a look is relooked about
// every BANNER_RELOOK_MS, but a tick captures at most BANNER_CAPTURES_PER_TICK of them, the ones looked at longest
// ago, so the captures spread over the relook period instead of landing together on one tick.
export const BANNER_CAPTURES_PER_TICK = 8;

// The due panes to capture this tick: the oldest looks first, never looked (at 0) first of all.
export function pickLooks<T extends { at: number }>(due: T[], cap: number = BANNER_CAPTURES_PER_TICK): T[] {
  return [...due].sort((x, y) => x.at - y.at).slice(0, cap);
}
