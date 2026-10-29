#!/usr/bin/env node
// S-4198: src/layout-ops.ts over the cases on stdin, for ops_test.go to compare with the Go port byte for byte. Each case
// is {layout, ops}: the ops apply one after another, each to the last good layout, with made-up ids n1, n2, ... in
// order. Prints, per case, two lines per op: the layout as JSON.stringify writes it, `error: MESSAGE` for an Error the
// module throws, or `typeerror` for a TypeError or SyntaxError (a tree or op of the wrong shape, which Go words its
// own way), then `valid: BOOL` for the layout after it. Then `valid: BOOL` for the last layout, `describe: ...` for each op (src/layout.ts describeOp), and the
// dead image tabs' close ops of the last layout, when it is valid, with page `live` live.
import { readFileSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
const { apply, validLayout, deadImageTabOps } = await import(new URL('src/layout-ops.ts', root));

// src/layout.ts describeOp, copied: importing layout.ts would read and write a home's layout.json.
function describeOp(op) {
  switch (op.op) {
    case 'open': return `open ${op.key} in ${op.world}`;
    case 'close': return `close ${op.key} in ${op.world}`;
    case 'swap': return `show ${op.with} in place of ${op.key} in ${op.world}`;
    case 'move': return `move ${op.key} to pane ${op.to} in ${op.world}`;
    case 'split': return `split pane ${op.pane} ${op.side} in ${op.world}`;
    case 'closePane': return `close pane ${op.pane} in ${op.world}`;
    case 'activate': return `show ${op.key} in pane ${op.pane} of ${op.world}`;
    case 'focus': return `focus pane ${op.pane} in ${op.world}`;
    case 'tabBar': return `${op.on ? 'show' : 'hide'} the tab bar of pane ${op.pane} in ${op.world}`;
    case 'resize': return `resize split ${op.split} in ${op.world}`;
    case 'setRoot': return `rearrange ${op.world}`;
    case 'dropWorld': return `drop the world ${op.world}`;
    case 'current': return `show ${op.world ?? 'home'}`;
  }
}

const OPS = new Set(['open', 'close', 'swap', 'move', 'split', 'closePane', 'activate', 'focus', 'tabBar', 'resize', 'setRoot', 'dropWorld', 'current']);
const cases = JSON.parse(readFileSync(0, 'utf8'));
const out = [];
for (const c of cases) {
  let n = 0;
  const made = () => `n${++n}`;
  let l = c.layout;
  const lines = [];
  for (const op of c.ops) {
    try {
      l = apply(l, op, made);
      lines.push(JSON.stringify(l));
    } catch (e) {
      lines.push(e instanceof TypeError || e instanceof SyntaxError ? 'typeerror' : `error: ${e.message}`);
    }
    lines.push(`valid: ${validLayout(l)}`);
  }
  lines.push(`valid: ${validLayout(l)}`);
  for (const op of c.ops) lines.push(`describe: ${OPS.has(op?.op) ? describeOp(op) : '-'}`);
  lines.push(`dead: ${validLayout(l) ? JSON.stringify(deadImageTabOps(l, (page) => page === 'live')) : '-'}`);
  out.push(lines);
}
console.log(JSON.stringify(out));
