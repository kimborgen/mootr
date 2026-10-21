#!/usr/bin/env node
// A stand-in for the merge script (S-2279), for pr_merge's tests: STAM_PR_MERGE_SCRIPT points at it.
//   node test/pr-merge-stub.mjs N
// It appends N to $STAM_PR_MERGE_STUB_DIR/calls, then acts on $STAM_PR_MERGE_STUB_DIR/N.mode:
//   merge   prints a merge sha and exits 0
//   refuse  prints the merge script's refusal line and exits 3
//   fail    prints a few lines and exits 1
//   hold    waits until N.release exists, then merges
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.STAM_PR_MERGE_STUB_DIR;
const pr = process.argv[2];
appendFileSync(join(dir, 'calls'), `${pr}\n`);
const mode = existsSync(join(dir, `${pr}.mode`)) ? readFileSync(join(dir, `${pr}.mode`), 'utf8').trim() : 'merge';
console.log(`merge PR ${pr}: started worker ${process.pid}, log /tmp/stub.log`);
if (mode === 'hold') {
  console.log('waiting: 2nd in the merge queue');
  while (!existsSync(join(dir, `${pr}.release`))) await new Promise((r) => setTimeout(r, 50));
}
if (mode === 'refuse') {
  console.error('merge refused: PR #' + pr + ' gates failed: tsc');
  process.exit(3);
}
if (mode === 'fail') {
  console.log('fetching origin');
  console.error('gave up after 0 min waiting for the gate lock (/tmp/gate.lock)');
  process.exit(1);
}
console.log('0123456789abcdef0123456789abcdef01234567');
