// Runs before every web test file (vite.config.ts `test.setupFiles`).
// jsdom has no layout and no scrolling: assistant-ui scrolls the thread from a
// requestAnimationFrame callback that can fire after a test ends, and an error
// there fails the whole vitest run. Stub the methods only where jsdom lacks them.
if (typeof Element !== 'undefined') {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
}
// CodeMirror measures text through ranges; jsdom has no layout, so give them empty rects.
if (typeof Range !== 'undefined') {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
}
