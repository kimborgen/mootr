// Classifies the hit-test samples of the phone check's touch-target step (S-1944). The page
// samples the centre and a point inside each edge of a target and records what
// `document.elementFromPoint` returned there; this module, with no browser, decides which samples
// fail and which are known (S-2249). It stays pure so test/hit-classify.test.mjs can feed it fixtures.
//
// A sample: { edge, by, inside, offscreen, inert, overlay, clipped, pinned, scrollsUnder }
//   edge          'centre' | 'top' | 'bottom' | 'left' | 'right'
//   by            identity of the element the point hit
//   inside        the hit is the target or a descendant
//   offscreen     the point is outside the viewport, so a finger can't reach it
//   inert         the target is `[inert]` or `[aria-hidden=true]`
//   overlay       the hit is in a declared overlay (OVERLAYS in hit-sample.mjs) the target isn't in
//   clipped       the point lies outside a scroller the target is in (scrolled out of view)
//   pinned        the hit is in a fixed or sticky bar that doesn't contain the target
//   scrollsUnder  the target's scroller can scroll the covered part clear of the pinned bar, so the cover is a scroll position

// A sample that a finger can't, or isn't expected to, tap: not a slip of the layout.
export const exempt = (s) => s.offscreen || s.inert || s.overlay || s.clipped || (s.pinned && s.scrollsUnder);

// Every failing sample of one target, centre and edges alike.
export const failing = (samples) => samples.filter((s) => !s.inside && !exempt(s));

export const knownKey = (where, target, s) => `${where} | ${target} | ${s.edge} | ${s.by}`;

// Splits a target's failing samples into those the allow-list names (`known`) and the rest
// (`fresh`). A target passes only when every failing sample is known, so a known bottom overlap
// plus a new right overlap fails. `seen` collects the keys that matched, for the stale report.
export const classify = (where, target, samples, known, seen = new Set()) => {
  const fresh = [], hit = [];
  for (const s of failing(samples)) {
    const k = knownKey(where, target, s);
    if (known.includes(k)) { seen.add(k); hit.push({ target, edge: s.edge, by: s.by }); }
    else fresh.push({ target, edge: s.edge, by: s.by });
  }
  return { fresh, known: hit };
};

export const describe = (c) => `${c.target} ${c.edge} edge covered by ${c.by}`;
