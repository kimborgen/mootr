// Waits until the page has settled before a shot or a hit test (S-3430): every finite animation on the page has ended
// (animationend, or its finish for a transition), and, when a selector is given, that element's effective opacity is 1.
// Opacity is not inherited, but a fade on an ancestor multiplies down to the element: a sheet's popover wrapper fades in
// (menu-in), so the check reads the opacity of the element and each ancestor. Endless animations (a working dot) are not
// waited for, since they never end. Returns true once settled, and false when `timeout` ms pass first: the caller reports
// that as a failure. Never a fixed sleep.
//   const ok = await settled(p, '.ipe-sheet')   // p: a Playwright page
export async function settled(p, selector = null, timeout = 5000) {
  try {
    await p.waitForFunction((sel) => {
      if (sel) {
        const el = document.querySelector(sel);
        if (!el) return false;
        for (let n = el; n; n = n.parentElement) if (parseFloat(getComputedStyle(n).opacity) < 1) return false;
      }
      return document.getAnimations().every((a) => !((a.playState === 'running' || a.pending) && a.effect?.getComputedTiming().endTime !== Infinity));
    }, selector, { timeout, polling: 'raf' });
    return true;
  } catch (e) {
    if (e.name === 'TimeoutError') return false;
    throw e;
  }
}
