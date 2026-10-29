// The phone check's touch-target sampler (hit-sample.mjs) and classifier (hit-classify.mjs) on a
// small static page, in Chromium (S-1944): the cases that must fail, and the declared states that
// are exempt. Needs no daemon and costs nothing.
//   node web/check/hit-sample-fixture.mjs
import './chromium-lock.mjs';
import { chromiumLaunchOptions } from './chromium-launch.mjs';
import { findPlaywright } from './find-playwright.mjs';
import { classify, knownKey } from './hit-classify.mjs';
import { OVERLAYS, sampleTargets } from './hit-sample.mjs';

const PAGE = `<!doctype html><meta name=viewport content="width=360">
<style>
  body { margin: 0; font: 16px sans-serif; } button { width: 120px; height: 44px; margin: 0; }
  .row { position: relative; height: 60px; } .over { position: absolute; z-index: 1; left: 0; top: 0; width: 60px; height: 44px; background: #ccc; }
  header.bar { position: fixed; top: 118px; right: 0; width: 100px; height: 60px; background: #ddd; }
  dialog { position: fixed; top: 540px; left: 0; width: 200px; height: 100px; margin: 0; padding: 0; }
  .scroller { height: 100px; overflow-y: auto; } .scroller .fill { height: 400px; } .scroller header.pin { position: sticky; top: 0; height: 30px; background: #eee; }
  .none { pointer-events: none; } footer.bnav { position: fixed; bottom: 0; left: 160px; right: 0; height: 190px; background: #ddd; }
</style>
<div class=row id=zover><button class=a>Under a sibling</button><div class=over></div></div>
<div class=row id=plain><button class=a>Plain</button></div>
<div class=row id=pinned><button class=a style="margin-left:260px;width:100px">Under bar</button></div>
<div class=row id=nopointer><button class="a none">No pointer</button></div>
<div class=row><div class=item data-itsa="x1"><button class=a>Open</button><div class=over></div></div></div>
<div class=row><div class=item data-itsa="x2"><button class=a>Open</button><div class=over></div></div></div>
<div class=row id=hover style="opacity:0"><button class=a>Hover only</button><div class=over></div></div>
<div class=scroller><header class=pin>pin</header><div class=fill><button class=a>Scrolled under</button></div></div>
<div class=row id=inertrow inert><button class=a>Inert target</button><div class=over></div></div>
<div class=row style="position:absolute;top:0;left:130px;width:20px"><div class=pair data-itsa="p1"><button class=u><i></i></button><button class=u><i></i></button></div></div>
<div id=ovl role=dialog aria-modal=true style="position:fixed;top:400px;left:200px;width:160px;height:60px;background:#eee"><button class=a style="width:100px">In overlay</button><div class=over style="left:0;top:0"></div></div>
<div class=row style="position:absolute;top:470px;left:200px"><button class=a style="width:100px">Last row</button></div>
<footer class=bnav>nav</footer>
<div class=row id=behind style="position:absolute;top:560px;left:10px"><button class=a>Behind dialog</button></div>
<header class=bar>bar</header>
<dialog open><p>dialog</p></dialog>
`;

// A second page for the pinned-bar and dialog cases, each in its own corner, so they don't
// cover one another. Scrollers E and F are 100 px high; G's bar and the dialogs sit after the targets.
const PAGE2 = `<!doctype html><meta name=viewport content="width=360">
<style>
  body { margin: 0; font: 16px sans-serif; } button { width: 120px; height: 44px; margin: 0; }
  .sc { position: absolute; left: 0; width: 160px; height: 100px; overflow-y: auto; }
  .sc .pad { height: 190px; } .sc .pad.s { height: 70px; } .sc .tail { height: 60px; }
  .sc footer { position: sticky; bottom: 0; height: 40px; background: #ddd; }
  .sc footer.pull { margin-top: -40px; }
</style>
<div class=sc id=E style="top:0"><div class=pad></div><button>At the end</button><footer class=pull></footer></div>
<div class=sc id=F style="top:120px"><div class=pad style="height:70px"></div><button>At the start</button><div style="height:200px"></div><footer></footer></div>
<div class=sc id=G style="top:240px"><button>Top of scroller</button><div class=pad></div></div>
<button style="position:absolute;top:360px;left:0">Under plain dialog</button>
<header style="position:fixed;top:240px;left:0;width:160px;height:30px;background:#ddd">bar</header>
<div role=dialog style="position:fixed;top:360px;left:0;width:160px;height:60px;background:#eee">not modal</div>
`;

// A third page for the scroller-edge tolerance (S-3461): two clipping scrollers, each with a fixed bar
// over its bottom edge. S1's button straddles the edge: its bottom sample lands 1 px inside it, under the
// bar. S2's button has its cover 5 px inside the edge, so `edge` must not hide it.
const PAGE3 = `<!doctype html><meta name=viewport content="width=360">
<style>
  body { margin: 0; font: 16px sans-serif; } button { width: 120px; height: 44px; margin: 0; }
  .sc { position: absolute; left: 0; width: 160px; height: 100px; overflow-y: auto; } .sc .gap { height: 58px; }
  header.bar { position: fixed; left: 0; width: 160px; height: 40px; background: #ddd; }
</style>
<div class=sc id=S1 style="top:0"><div class=gap></div><button>Straddle bottom</button></div>
<header class=bar style="top:98px">bar</header>
<div class=sc id=S2 style="top:300px"><div class=gap style="height:54px"></div><button>Cover inside</button></div>
<header class=bar style="top:390px">bar</header>
`;

const { chromium } = findPlaywright();
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await (await browser.newContext({ viewport: { width: 360, height: 640 } })).newPage();
await page.setContent(PAGE);
// Scroll the scroller so its button slides under the sticky header.
await page.evaluate(() => { const s = document.querySelector('.scroller'); s.scrollTop = 20; });
const sampled = await page.evaluate(sampleTargets, { selector: 'button', exclude: null, overlays: OVERLAYS, inset: 3 });
await page.setContent(PAGE2);
await page.evaluate(() => { document.getElementById('E').scrollTop = 9999; });
const sampled2 = await page.evaluate(sampleTargets, { selector: 'button', exclude: null, overlays: OVERLAYS, inset: 3 });
await page.setContent(PAGE3);
const sampledEdge = await page.evaluate(sampleTargets, { selector: 'button', exclude: null, overlays: OVERLAYS, inset: 3, edge: 1.5 });
const sampledNoEdge = await page.evaluate(sampleTargets, { selector: 'button', exclude: null, overlays: OVERLAYS, inset: 3, edge: 0 });
await browser.close();

let failed = 0;
const check = (ok, msg, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}${ok ? '' : ': ' + detail}`); if (!ok) failed++; };
const by = (label) => sampled.filter((c) => c.t.includes(`[${label}`));
const fresh = (c, known = []) => classify('page', c.t, c.samples, known).fresh;

const sib = by('Under a sibling')[0];
check(sib && fresh(sib).some((f) => f.edge === 'left' || f.edge === 'top'), 'an absolute z-index:1 sibling over a button fails', JSON.stringify(sib));
const plain = by('Plain')[0];
check(plain && !fresh(plain).length, 'a plain button passes', JSON.stringify(plain));
const bar = by('Under bar')[0];
check(bar && fresh(bar).length > 0, 'a fixed header over a button that does not scroll fails', JSON.stringify(bar));
const np = by('No pointer')[0];
check(np && fresh(np).length > 0, 'a visible pointer-events:none button fails', JSON.stringify(np));
const opens = by('Open');
check(opens.length === 2 && opens[0].t !== opens[1].t, 'two same-class rows with different data-itsa get different names', opens.map((o) => o.t).join(' | '));
const known = [knownKey('page', opens[0].t, fresh(opens[0])[0] ?? {})];
check(fresh(opens[0], known).length === 0 && fresh(opens[1], known).length > 0, 'only the listed row is known; the other fails', JSON.stringify(known));
check(!by('Hover only').length || by('Hover only')[0].samples.length === 0, 'a fully transparent (hover-only) control is not sampled', JSON.stringify(by('Hover only')));
const behind = by('Behind dialog')[0];
check(behind && behind.samples.some((s) => s.overlay) && !fresh(behind).length, 'a dialog over page content is exempt', JSON.stringify(behind));
check(sampled.every((c) => !/\d{4,}/.test(c.t)), 'names carry no long digit runs');
const su = by('Scrolled under')[0];
check(su && su.samples.some((s) => s.pinned && s.scrollsUnder) && !fresh(su).length, 'a control scrolled under its sticky header, with room to scroll back, is exempt by the scroll rule', JSON.stringify(su));
const ib = by('Inert target')[0];
check(ib && ib.samples.some((s) => s.inert) && !fresh(ib).length, 'an inert target is exempt', JSON.stringify(ib));
const io = by('In overlay')[0];
check(io && fresh(io).length > 0, 'a target in an overlay, covered by a sibling in the same overlay, fails', JSON.stringify(io));
const lr = by('Last row')[0];
check(lr && lr.samples.some((s) => s.pinned && !s.scrollsUnder) && fresh(lr).length > 0, 'a last row under a fixed bottom bar with no scroll room fails', JSON.stringify(lr));
const us = sampled.filter((c) => c.t.includes('button.u'));
check(us.length === 2 && us[0].t !== us[1].t, 'two same-class unlabelled siblings under one anchor get different names', us.map((u) => u.t).join(' | '));
const by2 = (label) => sampled2.find((c) => c.t.includes(`[${label}`));
const end = by2('At the end'), start = by2('At the start'), top = by2('Top of scroller'), nm = by2('Under plain dialog');
check(end && end.samples.some((s) => s.pinned && !s.scrollsUnder) && fresh(end).length > 0, 'a scroller scrolled to its end, with a sticky bottom footer over its last button, fails', JSON.stringify(end));
check(start && start.samples.some((s) => s.pinned && s.scrollsUnder) && !fresh(start).length, 'the same bar over a button that can still scroll clear (scrollTop 0) is exempt', JSON.stringify(start));
check(top && top.samples.some((s) => s.pinned && !s.scrollsUnder) && fresh(top).length > 0, 'a fixed top bar over a scroller at scrollTop 0 fails', JSON.stringify(top));
check(nm && fresh(nm).length > 0 && !nm.samples.some((s) => s.overlay), 'a role=dialog without aria-modal covering a target fails', JSON.stringify(nm));
const straddle = sampledEdge.find((c) => c.t.includes('[Straddle bottom'));
const straddleNoEdge = sampledNoEdge.find((c) => c.t.includes('[Straddle bottom'));
const coverIn = sampledEdge.find((c) => c.t.includes('[Cover inside'));
check(straddle && straddle.samples.some((s) => s.clipped) && !fresh(straddle).length, 'with edge 1.5, a button straddling a clipping scroller\'s bottom edge under a fixed bar is skipped', JSON.stringify(straddle));
check(straddleNoEdge && fresh(straddleNoEdge).length > 0, 'with edge 0, the same straddle still reports the cover', JSON.stringify(straddleNoEdge));
check(coverIn && fresh(coverIn).length > 0, 'with edge 1.5, a cover 5 px inside the scroller still fails', JSON.stringify(coverIn));
process.exit(failed ? 1 : 0);
