#!/usr/bin/env node
// Gate for web/check page code that can't run (S-1392, from S-1387), read from the JavaScript AST (not regexes, S-1657)
// so strings, comments and nested templates can't confuse it: a Playwright-only selector (`:visible`, `:has-text(`, `>>`,
// `text=`...) in page code (the arguments of evaluate, evaluateAll, evaluateHandle, waitForFunction, and everything after the
// selector of $eval and $$eval; see `scan` for the forms followed and the ones not). Native
// querySelector throws a SyntaxError there, and with a `.catch(() => {})` on the wait the check never waited (S-1381 #462).
// A second shape was tried and dropped: a waitForFunction/waitForSelector/waitForResponse with its error swallowed. It had
// 20 sites in web/check, all deliberate (an assertion follows), so every new one would have cost an allowlist edit for nothing.
// A deliberate Playwright-only string in page code goes in BROWSER_OK with a reason.
// Free, no daemon: `node --test test/swallowed-wait.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const BROWSER_FNS = new Set(['evaluate', 'evaluateAll', 'evaluateHandle', 'waitForFunction', '$eval', '$$eval']);
// The first argument of these goes to Playwright's selector engine, where :visible and friends are fine.
const SELECTOR_FIRST = new Set(['$eval', '$$eval']);
// Selector syntax only Playwright's engine understands: pseudo-classes, the `>>` chain, and engine prefixes.
const PLAYWRIGHT_ONLY = /:visible\b|:has-text\(|:text(?:-is|-matches)?\(|:nth-match\(|>>|^\s*(?:text|xpath|role|css|id)=/;

const callName = (n) => (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : null);
const isFn = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n);

// The string pieces of a node: plain strings, and the literal parts of templates (the `${}` holes are walked on).
function stringsIn(node, f) {
  const v = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) f(n.text);
    ts.forEachChild(n, v);
  };
  v(node);
}

// { browserSelectors: [{ fn, text }] } for one source text. Page code is found in the function, string and name
// arguments of the browser functions: an inline arrow, a selector passed as an argument
// (`waitForFunction((s) => document.querySelector(s), '.v:visible')`), and a same-file `const` or function
// passed by name (`hold`, `until`'s `fn`). A local wrapper, a same-file function that hands one of its parameters to a
// browser function (viewtoggle.mjs `until`), has the arguments at those positions scanned at its call sites.
// Not followed: a body or string built in another file, held in an object or array, or returned by a call; a wrapper
// of a wrapper; a name that is a parameter of an enclosing function.
export function scan(text, name = 'x.mjs') {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const browserSelectors = [];
  const decls = new Map(); // name -> initializer or function declaration
  const fns = []; // [{ name, node }] functions bound to a name
  const collect = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      decls.set(n.name.text, n.initializer);
      if (isFn(n.initializer)) fns.push({ name: n.name.text, node: n.initializer });
    } else if (ts.isFunctionDeclaration(n) && n.name) {
      decls.set(n.name.text, n);
      fns.push({ name: n.name.text, node: n });
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  // wrapper name -> parameter positions handed to a browser function
  const wrappers = new Map();
  for (const { name: wn, node } of fns) {
    const params = node.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
    const find = (n) => {
      const c = callName(n);
      if (c && BROWSER_FNS.has(c)) {
        n.arguments.forEach((a, k) => {
          const i = ts.isIdentifier(a) && !(k === 0 && SELECTOR_FIRST.has(c)) ? params.indexOf(a.text) : -1;
          if (i >= 0) wrappers.set(wn, [...(wrappers.get(wn) ?? []), i]);
        });
      }
      ts.forEachChild(n, find);
    };
    if (node.body) find(node.body);
  }
  // Is NAME a parameter of a function around NODE? Then it isn't the file-level declaration of that name.
  const isParam = (node, name) => {
    for (let q = node.parent; q; q = q.parent) if (isFn(q) || ts.isFunctionDeclaration(q)) if (q.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) return true;
    return false;
  };
  // Scans a function body or a string, template, object or array literal; a name is resolved to its same-file declaration.
  // A call or await (`await p.$('.row:visible')`) is not page code or a page string, so it is skipped.
  const report = (fn, node, depth = 0) => {
    if (ts.isIdentifier(node)) {
      if (depth < 3 && decls.has(node.text) && !isParam(node, node.text)) report(fn, decls.get(node.text), depth + 1);
      return;
    }
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node);
    if (!isFn(node) && !ts.isFunctionDeclaration(node) && !literal) return;
    stringsIn(isFn(node) || ts.isFunctionDeclaration(node) ? node.body : node, (s) => PLAYWRIGHT_ONLY.test(s) && browserSelectors.push({ fn, text: s }));
  };
  const visit = (n) => {
    const c = callName(n);
    if (c && BROWSER_FNS.has(c)) n.arguments.forEach((a, i) => { if (!(i === 0 && SELECTOR_FIRST.has(c))) report(c, a); });
    const w = ts.isCallExpression(n) && ts.isIdentifier(n.expression) ? n.expression.text : null;
    if (w && wrappers.has(w)) for (const i of wrappers.get(w)) if (n.arguments[i]) report(w, n.arguments[i]);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { browserSelectors };
}

// Playwright-only strings that are deliberate in page code: { file, has, why }. None today.
export const BROWSER_OK = [];

const checkDir = resolve(fileURLToPath(import.meta.url), '../../web/check');
const sites = () => {
  const out = [];
  for (const f of readdirSync(checkDir).filter((n) => n.endsWith('.mjs'))) {
    out.push(...scan(readFileSync(join(checkDir, f), 'utf8'), f).browserSelectors.map((x) => ({ file: f, ...x })));
  }
  return out;
};

test('gate: no Playwright-only selector runs in the browser', () => {
  for (const e of BROWSER_OK) assert.ok(e.why && e.why.length > 10, `allowlist entry ${e.file} ${e.has} needs a reason`);
  const found = sites();
  const hits = found.filter((h) => !BROWSER_OK.some((e) => e.file === h.file && h.text.includes(e.has))).map((h) => `${h.file}: ${JSON.stringify(h.text)} in ${h.fn}`);
  assert.deepEqual(hits, [], 'page code uses native querySelector: :visible, :has-text, >> and text= throw a SyntaxError there; use a Playwright locator, or check visibility in the function');
  const stale = BROWSER_OK.filter((e) => !found.some((h) => e.file === h.file && h.text.includes(e.has))).map((e) => `${e.file}: ${e.has}`);
  assert.deepEqual(stale, [], 'these BROWSER_OK entries match nothing any more: remove them');
});

// The matcher itself: each case fails to be seen if the check regresses.
test('matcher: a Playwright selector in page code is found, in each browser function', () => {
  const t = (src) => scan(src).browserSelectors.map((h) => h.fn);
  assert.deepEqual(t("await p.waitForFunction(() => !!document.querySelector('.swipe-view:visible .swipe-top'))"), ['waitForFunction']);
  assert.deepEqual(t("await p.evaluate(() => document.querySelectorAll('.a >> .b'))"), ['evaluate']);
  assert.deepEqual(t("await el.$$eval('x', () => document.querySelector('li:has-text(\"a\")'))"), ['$$eval']);
  assert.deepEqual(t("await p.$eval('x', function () { return document.querySelector('text=Save'); })"), ['$eval']);
  assert.deepEqual(t('await p.waitForFunction((id) => document.querySelector(`.v:visible[data-id="${id}"]`), id)'), ['waitForFunction']);
});

test('matcher: Playwright selectors outside page code, and native ones inside it, are not found', () => {
  const t = (src) => scan(src).browserSelectors.length;
  assert.equal(t("await p.waitForSelector('.v:visible .msg')"), 0);
  assert.equal(t("await p.locator('li:has-text(\"a\")').click()"), 0);
  assert.equal(t("await p.waitForFunction(() => document.querySelector('.v:not(.hidden) [data-text=a]'))"), 0);
  assert.equal(t("await p.evaluate(() => { /* .a:visible */ return 1 >> 2; })"), 0);
  assert.equal(t("await p.evaluate(() => document.querySelector('.a:has(.b)'))"), 0);
});

test('matcher: evaluateAll, evaluateHandle and selector arguments are found', () => {
  const t = (src) => scan(src).browserSelectors.map((h) => h.fn);
  assert.deepEqual(t("await p.locator('.a').evaluateAll((els) => els.filter((e) => e.matches('.b:visible')))"), ['evaluateAll']);
  assert.deepEqual(t("await p.evaluateHandle(() => document.querySelector('.a:has-text(\"x\")'))"), ['evaluateHandle']);
  assert.deepEqual(t("await p.waitForFunction((s) => document.querySelector(s), '.v:visible')"), ['waitForFunction']);
  assert.deepEqual(t("await p.evaluate((s) => document.querySelector(s), { sel: 'a >> b' })"), ['evaluate']);
});

test('matcher: the first argument of $eval and $$eval goes to Playwright and is not found', () => {
  const t = (src) => scan(src).browserSelectors.length;
  assert.equal(t("await p.$eval('.v:visible', (e) => e.id)"), 0);
  assert.equal(t("await p.$$eval('li:has-text(\"a\")', (els) => els.length)"), 0);
  assert.equal(t("await p.$eval('.v:visible', (e, s) => e.matches(s), '.x:visible')"), 1);
});

test('matcher: a body or selector passed by name is followed, and so are local wrappers', () => {
  const t = (src) => scan(src).browserSelectors.map((h) => h.fn);
  assert.deepEqual(t("const hold = () => document.querySelector('.a:visible');\nawait p.evaluate(hold);"), ['evaluate']);
  assert.deepEqual(t("function release() { return document.querySelector('.a:visible'); }\nawait p.evaluate(release);"), ['evaluate']);
  assert.deepEqual(t("const SEL = '.v:visible';\nawait p.waitForFunction((s) => document.querySelector(s), SEL);"), ['waitForFunction']);
  const wrap = "const until = (p, fn, arg) => p.waitForFunction(fn, arg, { timeout: 10000 });\n";
  assert.deepEqual(t(wrap + "await until(p, () => document.querySelector('.a:visible'))"), ['until']);
  assert.deepEqual(t(wrap + "await until(p, (k) => k, '.a >> .b')"), ['until']);
  assert.equal(t(wrap + "await until(p, () => document.querySelector('.a'), 'x')").length, 0);
  assert.equal(t("const hold = () => document.querySelector('.a');\nawait p.evaluate(hold);").length, 0);
});

test('matcher: engine prefixes count only at the start of a selector string', () => {
  const t = (src) => scan(src).browserSelectors.length;
  assert.equal(t("await p.evaluate(() => document.querySelector('text=Save'))"), 1);
  assert.equal(t("await p.evaluate(() => document.querySelector('.row text=x'))"), 0);
  assert.equal(t("await p.evaluate(() => 'the id=5 row')"), 0);
});

test('matcher: wrappers of $eval, call results and shadowed names are not found', () => {
  const t = (src) => scan(src).browserSelectors.length;
  assert.equal(t("const q = (p, sel) => p.$eval(sel, (e) => e.id);\nawait q(p, '.v:visible');"), 0);
  assert.equal(t("const q = (p, sel, arg) => p.$eval('x', (e, a) => a, arg);\nawait q(p, 'x', '.v:visible');"), 1);
  assert.equal(t("await p.evaluate((r) => r.click(), await p.$('.row:visible'))"), 0);
  assert.equal(t("await p.evaluate((r) => r.click(), p.locator('.row:visible'))"), 0);
  assert.equal(t("const sel = '.v:visible';\nconst f = (sel) => p.waitForFunction((s) => document.querySelector(s), sel);"), 0);
});
