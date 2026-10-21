// The in-page half of the phone check's touch-target hit-test (S-1944): it samples the centre and a
// point inside each edge of every touch target with `document.elementFromPoint`, and names both the
// target and what covered it. web/check/hit-classify.mjs decides which samples fail. The sampler
// is one self-contained function, so Playwright can run it in the page; test/hit-sampler runs the
// same function on a static page (web/check/hit-sample-fixture.mjs).
//
// Fail-closed: a sample is exempt only for a declared state, never a guess.
//   - the target is `[inert]` or `[aria-hidden=true]`;
//   - the point is covered by a declared overlay (OVERLAYS) the target isn't in;
//   - the point is off the screen, or scrolled out of a scroller the target is in;
//   - a fixed or sticky coverer, when the target's scroller can scroll the covered part clear of it.
// Anything else that covers a target is a hit; known ones go on the S-2249 allow-list in phone.mjs.

// Layers that legitimately sit over the page: a target behind one isn't reachable until it closes.
export const OVERLAYS = [
  'dialog[open]', // a native modal dialog
  '[role=dialog][aria-modal=true]', // a modal ARIA dialog; a plain role=dialog (an in-flow card) is not a layer
  '[role=menu]', // an open menu
  '.menu', // the app's popup menu (+, row, tab menus)
  '.toast', // a transient notice
  '.spawn-panel', // the Add an agent panel, over the tree
  '.proc-sheet', // the process view's detail and edit sheets
  '.world.mobile-open', // the phone's drawer that slides over the pane
  '#search-palette', // the search palette, a full-screen layer
  '#suggest-modal', // the suggest-a-change modal
  '#top-world', // the assistant and chief-of-staff world, which covers the main world while open
  '.dv-sheet', // the diff view's changed-files sheet (position:absolute over the view)
  '.dv-review-pop', // the diff view's review-verdict popover (position:absolute)
  '.dv-text-pop', // the diff view's wrap and text-size popover (position:absolute)
  '.wait-pop', // the waiting-on-you popover (position:fixed)
  '.decl-pick', // DeclPicker, the popover on desktop and the bottom sheet on the phone (position:fixed)
  '[data-overlay]', // any other layer that marks itself as one
];

export const sampleTargets = ({ selector, exclude, overlays, inset }) => {
  const W = innerWidth, H = innerHeight;
  const vis = (el) => { const s = getComputedStyle(el); const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.opacity !== '0' && !el.closest('[hidden]'); };
  // Fully transparent anywhere up the tree: shown only on hover or focus, not a target a finger can see.
  const faded = (el) => { for (let a = el; a; a = a.parentElement) if (getComputedStyle(a).opacity === '0') return true; return false; };
  const OV = overlays.join(', ');

  // Stable names. A data id is volatile (it differs per run), so it becomes an alias numbered in
  // document order: itsa#1, itsa#2. Every element keeps its label and its data value (aliased).
  const ID = ['data-itsa', 'data-agent', 'data-id', 'data-key'];
  const aliases = new Map();
  for (const attr of ID) {
    const seen = new Map();
    for (const e of document.querySelectorAll(`[${attr}]`)) { const v = e.getAttribute(attr); if (!seen.has(v)) seen.set(v, `${attr.slice(5)}#${seen.size + 1}`); }
    aliases.set(attr, seen);
  }
  const data = (e) => ID.map((a) => (e.hasAttribute(a) ? aliases.get(a).get(e.getAttribute(a)) : '')).filter(Boolean).join(',');
  const mask = (t) => t.replace(/\d+/g, '#').replace(/\/[\w.\-/]+/g, '/path').trim().slice(0, 24);
  // A target keeps its full text label. A coverer names itself by text only when it has no element
  // children: the index tells its siblings apart, and editing copy elsewhere mustn't break known entries.
  const label = (e, target) => mask(e.getAttribute('aria-label') || e.getAttribute('title') || (target || e.children.length === 0 ? e.textContent : ''));
  const anchored = (e) => !!e.id || ID.some((a) => e.hasAttribute(a));
  // The index of an element among its siblings of the same tag and first class, when there are
  // several, so two unlabelled `button.btn` in one row differ. An optional sibling of another
  // class doesn't shift it.
  const nth = (e) => {
    const sib = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName && (c.classList[0] ?? '') === (e.classList[0] ?? '')) : [e];
    return sib.length > 1 ? `:${sib.indexOf(e) + 1}` : '';
  };
  const step = (e) => `${e.tagName.toLowerCase()}${e.classList.length ? '.' + e.classList[0] : ''}${nth(e)}`;
  // anchor (nearest ancestor with a stable identity, or body) > tag:nth steps > tag.classes[label|data]
  const name = (el, target) => {
    const steps = [];
    let a = el;
    for (; a && a !== document.body && !(a !== el && anchored(a)); a = a.parentElement) steps.unshift(step(a));
    const from = a && a !== document.body ? `${a.id ? '#' + a.id : ''}${data(a) ? '{' + data(a) + '}' : ''}` : 'body';
    const leaf = `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')}${nth(el)}`;
    const tag = [label(el, target), data(el)].filter(Boolean).join('|');
    // Only the two steps above the leaf: optional siblings higher up (a banner, a chip row) shift
    // the deeper indexes between runs, while the anchor, label and data keep the name unique.
    const path = steps.slice(0, -1).slice(-2);
    return `${from}>${steps.length > 3 ? '…>' : ''}${path.join('>')}${path.length ? '>' : ''}${leaf}${tag ? '[' + tag + ']' : ''}`;
  };

  // Covered by a declared overlay the target isn't inside (the drawer holds the tree: its own rows are in it).
  const overlaid = (el, h) => { for (let a = h.closest(OV); a; a = a.parentElement?.closest(OV)) if (!a.contains(el)) return true; return false; };
  const clipped = (el, x, y) => { for (let a = el.parentElement; a; a = a.parentElement) { if (getComputedStyle(a).overflowY === 'visible') continue; const r = a.getBoundingClientRect(); if (y < r.top || y >= r.bottom || x < r.left || x >= r.right) return true; } return false; };
  // The fixed or sticky bar that holds `h`, when the target isn't inside it.
  const bar = (el, h) => { for (let a = h; a; a = a.parentElement) { const pos = getComputedStyle(a).position; if ((pos === 'fixed' || pos === 'sticky') && !a.contains(el)) return a; } return null; };
  // A pinned cover is a scroll position, not a slip, only if the target's scroller can scroll the
  // target clear of the bar and still keep it in view: the scroller has room for the shift (down:
  // bar bottom - target top, from scrollTop; up: target bottom - bar top, from what is left), and the
  // shifted target lies inside the scroller's visible box.
  const canClear = (el, a) => {
    for (let sc = el.parentElement; sc; sc = sc.parentElement) {
      if (!/auto|scroll/.test(getComputedStyle(sc).overflowY) || sc.scrollHeight <= sc.clientHeight + 1) continue;
      const t = el.getBoundingClientRect(), r = a.getBoundingClientRect(), v = sc.getBoundingClientRect();
      const down = r.bottom - t.top, up = t.bottom - r.top;
      const left = sc.scrollHeight - sc.clientHeight - sc.scrollTop;
      return (down <= sc.scrollTop + 1 && t.bottom + down <= v.bottom + 1) || (up <= left + 1 && t.top - up >= v.top - 1);
    }
    return false;
  };

  const inView = (b) => b.bottom > 0 && b.top < H && b.right > 0 && b.left < W;
  return [...document.querySelectorAll(selector)]
    .filter((el) => vis(el) && inView(el.getBoundingClientRect()) && !(exclude && el.closest(exclude)))
    .map((el) => {
      const b = el.getBoundingClientRect();
      const out = { t: name(el, true), w: b.width, h: b.height, samples: [] };
      if (faded(el)) return out;
      const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
      const pts = [['centre', cx, cy], ['top', cx, b.top + inset], ['bottom', cx, b.bottom - inset], ['left', b.left + inset, cy], ['right', b.right - inset, cy]];
      const targetInert = !!el.closest('[inert], [aria-hidden=true]');
      for (const [edge, x, y] of pts) {
        if (x < 0 || y < 0 || x >= W || y >= H) { out.samples.push({ edge, offscreen: true, inside: true }); continue; }
        const hit = document.elementFromPoint(x, y);
        if (!hit) { out.samples.push({ edge, offscreen: true, inside: true }); continue; }
        const inside = el.contains(hit);
        out.samples.push(inside ? { edge, inside } : {
          edge, inside, by: name(hit), inert: targetInert,
          overlay: overlaid(el, hit),
          clipped: clipped(el, x, y), pinned: !!bar(el, hit), scrollsUnder: !!bar(el, hit) && canClear(el, bar(el, hit)),
        });
      }
      return out;
    });
};
