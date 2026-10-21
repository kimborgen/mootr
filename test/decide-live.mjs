#!/usr/bin/env node
// One live call to the decision model (settings.decisions.model, microsoft/microsoft-decision-1 through
// OpenRouter, about $0.00001): decide() returns a probability. In --smoke only, through a throwaway
// STAM_HOME with a real key (test/e2e-decide-live.sh sets it up).
import { decide } from '../src/decide.ts';

const r = await decide(
  'Is 7 a prime number? Answer about the number 7.',
  { p: { type: 'noul', instructions: 'Is the number 7 prime?' } },
  { purpose: 'decide:live-test' },
);
if (!r) {
  console.error('FAIL: decide returned null (no key, or the call failed)');
  process.exit(1);
}
const p = r.answers?.p?.noul;
if (typeof p !== 'number' || p < 0 || p > 1) {
  console.error('FAIL: no noul probability', JSON.stringify(r));
  process.exit(1);
}
if (p < 0.5) {
  console.error('FAIL: the model did not say 7 is prime:', p);
  process.exit(1);
}
console.log(`decide-live: P(7 prime) = ${p.toFixed(3)} (${r.model})`);
