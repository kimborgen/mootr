import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StallMeter } from '../src/stall.ts';

// A mocked clock: the meter reads `t`, and a test moves it forward where a call would block.
function meterAt(lines) {
  const clock = { t: 0 };
  const meter = new StallMeter((l) => lines.push(l), () => clock.t);
  meter.threshold = 100;
  return { meter, clock };
}

test('a labelled stall is logged with its label and time', () => {
  const lines = [];
  const { meter, clock } = meterAt(lines);
  meter.timed('reconcile', () => (clock.t += 120));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z event loop stalled 120 ms during reconcile$/);
});

test('a labelled stall does not hide unlabelled blocking in the same tick', () => {
  const lines = [];
  const { meter, clock } = meterAt(lines);
  meter.tick(clock.t);
  clock.t += 10;
  meter.timed('labelled', () => (clock.t += 120));
  clock.t += 480; // unlabelled sync work
  meter.tick(clock.t);
  // The log line is rate-limited; the recent list keeps every stall.
  assert.deepEqual(meter.recent.map((s) => [s.ms, s.label]), [
    [120, 'labelled'],
    [480, 'unlabelled'],
  ]);
});

test('a nested call is logged once, under the innermost label', () => {
  const lines = [];
  const { meter, clock } = meterAt(lines);
  meter.timed('outer', () => {
    clock.t += 10;
    meter.timed('inner', () => (clock.t += 400));
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], / during inner$/);
  assert.equal(meter.recent.length, 1);
  assert.equal(meter.recent[0].label, 'inner');
});

test('an outer call logs its own significant time apart from the nested one', () => {
  const lines = [];
  const { meter, clock } = meterAt(lines);
  meter.timed('outer', () => {
    clock.t += 200;
    meter.timed('inner', () => (clock.t += 150));
  });
  assert.deepEqual(meter.recent.map((s) => [s.ms, s.label]), [
    [150, 'inner'],
    [200, 'outer'],
  ]);
});

test('the log is rate-limited to one line per ten seconds, with the count', () => {
  const lines = [];
  const { meter, clock } = meterAt(lines);
  for (const at of [0, 1_000, 2_000]) {
    clock.t = at;
    meter.timed('block', () => (clock.t += 120));
  }
  assert.equal(lines.length, 1);
  clock.t = 10_000;
  meter.timed('block', () => (clock.t += 130));
  assert.equal(lines.length, 2);
  assert.match(lines[1], / 130 ms during block \(2 more since the last line\)$/);
  assert.equal(meter.recent.length, 4);
});

test('the recent stalls keep the last twenty', () => {
  const lines = [];
  const { meter, clock } = meterAt(lines);
  for (let i = 0; i < 25; i++) {
    clock.t = i * 20_000;
    meter.timed(`label ${i}`, () => (clock.t += 100));
  }
  assert.equal(meter.recent.length, 20);
  assert.equal(meter.recent[0].label, 'label 5');
});

test('the many-short-calls line names the top three labels by ms, each with its ms and count', () => {
  const lines = [];
  const { meter, clock } = meterAt(lines);
  meter.tick(clock.t);
  const add = (label, ms, n) => {
    for (let i = 0; i < n; i++) meter.timed(label, () => (clock.t += ms / n));
  };
  add('a', 60, 3);
  add('b', 40, 4);
  add('c', 20, 1);
  add('d', 10, 2);
  add('e', 5, 2);
  meter.tick(clock.t + 10);
  assert.equal(meter.recent.at(-1).label, 'many short calls (n=12, top: a 60 ms/3, b 40 ms/4, c 20 ms/1)');
});

test('many short calls in one delayed tick are named, not dropped', () => {
  const lines = [];
  const { meter, clock } = meterAt(lines);
  meter.tick(clock.t);
  for (let i = 0; i < 10; i++) meter.timed('request', () => (clock.t += 50));
  meter.tick(clock.t + 10);
  assert.deepEqual(meter.recent.map((s) => [s.ms, s.label]), [[500, 'many short calls (n=10, top: request 500 ms/10)']]);
});

test('short calls too small to explain a delay leave the rest as unlabelled', () => {
  const lines = [];
  const { meter, clock } = meterAt(lines);
  meter.tick(clock.t);
  meter.timed('request', () => (clock.t += 50));
  clock.t += 150; // unlabelled work, bigger than the short calls
  meter.tick(clock.t + 10);
  assert.deepEqual(meter.recent.map((s) => [s.ms, s.label]), [[200, 'unlabelled']]);
});

test('a stall that overlaps a GC is noted with the GC time and kind', () => {
  const lines = [];
  const { meter, clock } = meterAt(lines);
  meter.noteGc({ startTime: 1000, duration: 280, detail: { kind: 4 } });
  clock.t = 900;
  meter.timed('block', () => (clock.t = 1220));
  assert.match(lines[0], / during block \(gc 280 ms, major\)$/);
});

test('a stall with no overlapping GC has no GC note', () => {
  const lines = [];
  const { meter, clock } = meterAt(lines);
  meter.noteGc({ startTime: 1000, duration: 280, detail: { kind: 1 } });
  clock.t = 5000;
  meter.timed('block', () => (clock.t = 5200));
  assert.match(lines[0], / during block$/);
});

test('a GC entry that arrives only later is noted when the deferred line is written', () => {
  const lines = [];
  const { meter, clock } = meterAt(lines);
  // perf_hooks queues the entry in the check phase: it's released only when the deferred write runs.
  const deferred = [];
  meter.defer = (fn) => deferred.push(fn);
  let released = false;
  meter.gcSource = { takeRecords: () => (released ? [{ startTime: 1000, duration: 280, detail: { kind: 4 } }] : []).splice(0) };
  clock.t = 900;
  meter.timed('block', () => (clock.t = 1220));
  assert.equal(lines.length, 0, 'the line waits for the deferred write');
  released = true;
  for (const fn of deferred.splice(0)) fn();
  assert.match(lines[0], / during block \(gc 280 ms, major\)$/);
});
