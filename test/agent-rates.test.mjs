#!/usr/bin/env node
// agentRates (S-344, src/usage-history.ts) gives each agent the numbers average() and hourRates() give for
// that agent alone, in one pass over the slots. Counts the slot visits, not the time. Throwaway, no daemon:
// `node --test test/agent-rates.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRates, average, hourRates, hourly } from '../src/usage-history.ts';

const cal = {
  intervals: [
    { from: '2026-10-10T08:10:00.000Z', to: '2026-10-10T11:40:00.000Z', change: 7, agents: { a: 3, b: 4 } },
    { from: '2026-10-11T14:00:00.000Z', to: '2026-10-11T16:30:00.000Z', change: 5, agents: { b: 2, c: 3 } },
    { from: '2026-10-12T20:05:00.000Z', to: '2026-10-12T22:55:00.000Z', change: 9, agents: { a: 1, c: 8 } },
  ],
};
const h = hourly(cal, Date.parse('2026-10-09T00:00:00.000Z'));

test('each agent gets the rates average() and hourRates() give it alone', () => {
  const got = agentRates(h, ['a', 'b', 'c', 'nobody']);
  for (const id of ['a', 'b', 'c']) {
    const members = new Set([id]);
    assert.deepEqual(got.get(id), { percent_per_hour: average(h, members), by_hour: hourRates(h, members) });
  }
  assert.deepEqual(got.get('nobody'), { percent_per_hour: 0, by_hour: hourRates(h, new Set(['nobody'])) });
});
