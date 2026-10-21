// S-1817: a plain selector defined twice in one scope of a shipped stylesheet is a class-name collision: the second rule silently
// restyles the first. This check fails on that, listing the file:line of each rule. A selector restyled under a media, supports or container
// query is a separate scope, so it passes. The parser is hand-rolled (no stylelint dependency): it strips comments, reads strings, and
// tracks the at-rule blocks that enclose each style rule.
//
// The baseline in dup-selectors.allow.json lists the duplicates main already has, each with its rule count and a reason. The check fails
// when a selector has more rules in a scope than its baseline count (a new duplicate has a count of 0), and reports a baseline entry as stale
// when its count has gone down, so the baseline only shrinks.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../../scripts/main-guard.mjs';

// The stylesheets the app ships. The tokens files hold custom properties only, so they are exempt.
export const SHIPPED_CSS = ['web/style.css', 'web/fonts.css', 'web/fonts-stam.css'];

export const BASELINE_FILE = 'web/check/dup-selectors.allow.json';

// At-rules whose blocks hold style rules in their own scope. Other at-rule blocks (@font-face, @keyframes, @page) are skipped: a repeated
// @font-face is legitimate (one per weight), and keyframe selectors (from, to, 50%) are not class names.
const SCOPE_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'document']);

// Blank out comments with spaces, keeping every newline and every other character at its offset, so the positions the parser reports still
// map to the source lines and the selectors keep their attribute values.
function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?(\*\/|$)/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

// The index just past the string literal that starts at `open`. Braces and semicolons inside it are not structure.
function skipString(text, open) {
  const quote = text[open];
  let i = open + 1;
  while (i < text.length && text[i] !== quote && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
  return Math.min(i + 1, text.length);
}

// The index of the brace that closes the one at `open`, or the end of the text when it is unclosed.
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '"' || text[i] === "'") i = skipString(text, i) - 1;
    else if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

// Walk the CSS once, front to back, and return one record per style rule: its scope (the enclosing at-rule preludes), its selector list, and
// its line. Offsets only grow during the walk, so the line counter advances through the file once.
export function styleRules(css) {
  const text = blankComments(css);
  const rules = [];
  let line = 1;
  let scanned = 0;
  function lineAt(offset) {
    for (; scanned < offset; scanned += 1) if (css[scanned] === '\n') line += 1;
    return line;
  }
  // `scope` is the chain of enclosing scope at-rules, joined so two different query chains never compare equal.
  function walk(start, end, scope) {
    let i = start;
    let preludeStart = start;
    while (i < end) {
      const c = text[i];
      if (c === '"' || c === "'") {
        i = skipString(text, i);
      } else if (c === ';' || c === '}') {
        i += 1;
        preludeStart = i;
      } else if (c === '{') {
        const head = text.slice(preludeStart, i).replace(/\s+/g, ' ').trim();
        const close = matchBrace(text, i);
        if (head.startsWith('@')) {
          const name = /^@([\w-]+)/.exec(head)?.[1] ?? '';
          if (SCOPE_AT_RULES.has(name)) walk(i + 1, close, `${scope}${head} {}`);
        } else if (head) {
          rules.push({ scope, selector: head, line: lineAt(preludeStart + text.slice(preludeStart, i).search(/\S/)) });
        }
        i = close + 1;
        preludeStart = i;
      } else {
        i += 1;
      }
    }
  }
  walk(0, text.length, '');
  return rules;
}

export function normaliseSelector(selector) {
  return selector.replace(/\s+/g, ' ').trim();
}

// The selectors that have two or more rules in one scope of one stylesheet: { file, scope, selector, lines } with the lines in source order.
export function duplicateGroups(file, css) {
  const groups = new Map();
  for (const rule of styleRules(css)) {
    const selector = normaliseSelector(rule.selector);
    const key = `${rule.scope}\u0000${selector}`;
    if (!groups.has(key)) groups.set(key, { file, scope: rule.scope, selector, lines: [] });
    groups.get(key).lines.push(rule.line);
  }
  return [...groups.values()].filter((group) => group.lines.length > 1);
}

const sameEntry = (a, b) => a.file === b.file && a.scope === b.scope && a.selector === b.selector;

// Compare the duplicate groups with the baseline. A group fails when it has more rules than its baseline count (0 when it isn't listed).
// A baseline entry is stale when the rules now number fewer than its count, including when it no longer duplicates at all.
export function compare(groups, baseline) {
  const failures = [];
  for (const group of groups) {
    const entry = baseline.find((e) => sameEntry(e, group));
    const allowed = entry?.count ?? 0;
    if (group.lines.length > allowed) failures.push({ ...group, allowed });
  }
  const stale = baseline.filter((entry) => {
    const group = groups.find((g) => sameEntry(entry, g));
    return (group?.lines.length ?? 0) < entry.count;
  });
  return { failures, stale };
}

export function checkFiles(root, files = SHIPPED_CSS, baseline = readBaseline(root)) {
  const groups = files.flatMap((file) => duplicateGroups(file, readFileSync(join(root, file), 'utf8')));
  return compare(groups, baseline);
}

export function readBaseline(root) {
  return JSON.parse(readFileSync(join(root, BASELINE_FILE), 'utf8'));
}

if (isMain(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { failures, stale } = checkFiles(root);
  for (const f of failures) {
    const where = f.lines.map((line) => `${f.file}:${line}`).join(', ');
    console.error(`${where}: selector "${f.selector}" is defined ${f.lines.length} times in the same scope (baseline allows ${f.allowed})`);
  }
  for (const s of stale) {
    console.error(`${BASELINE_FILE}: "${s.selector}" in ${s.file} has fewer rules than its count ${s.count}; lower the count or remove the entry`);
  }
  if (failures.length || stale.length) {
    console.error('Merge or rename the duplicate, or add a reasoned entry to the baseline. Lower counts or remove entries that no longer duplicate.');
    process.exit(1);
  }
  console.log(`no new duplicate selectors in ${SHIPPED_CSS.join(', ')}`);
}
