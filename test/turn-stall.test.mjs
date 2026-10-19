#!/usr/bin/env node
// The turn index never stalls the daemon (S-1580): the turn backfill and a Stop on an uncached
// transcript parse Claude transcripts off the event loop. Large generated transcripts (tens of MB,
// no real AI) are backfilled while perf_hooks measures the event loop's longest delay.
// Run with `node --test test/turn-stall.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { tempDir } from './tmphome.mjs';

const home = tempDir('stam-turn-stall-');
process.env.STAM_HOME = home;
process.env.STAM_EMBEDDER = 'stub';
const db = await import('../src/db.ts');
const { MACHINE } = await import('../src/config.ts');
const { currentModel } = await import('../src/embed.ts');
const T = await import('../src/turn-vectors.ts');
const { cachedTranscripts } = await import('../src/adapters/claude-view.ts');

// The longest event-loop delay the change may cause: the goal is 50 ms; the margin is for a loaded
// machine's scheduler, not for parsing (one 1 MB parse alone takes about 17 ms).
const MAX_DELAY_MS = 150;
const OUTPUT = 'x'.repeat(16_000);

// One turn's rows: a prompt, a tool call with a 16 KB result, and a reply, starting at `t`.
function turnRows(name, i, t) {
  const at = (k) => new Date(t + k).toISOString();
  return (
    [
      { type: 'user', uuid: `${name}-u${i}`, timestamp: at(0), message: { role: 'user', content: `${name} prompt ${i}: fix the ledger` } },
      { type: 'assistant', uuid: `${name}-a${i}`, timestamp: at(1), message: { content: [{ type: 'tool_use', id: `${name}-t${i}`, name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', uuid: `${name}-r${i}`, timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: `${name}-t${i}`, content: OUTPUT }] } },
      { type: 'assistant', uuid: `${name}-b${i}`, timestamp: at(3), message: { content: [{ type: 'text', text: `done ${i}` }] } },
      { type: 'system', subtype: 'turn_duration', uuid: `${name}-s${i}`, timestamp: at(4) },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  );
}

// A Claude Code transcript of `mb` MB, its turns a minute apart, the last one at `end`. The ids
// name each turn, so a test can find it.
function transcript(name, mb, end) {
  const file = join(home, `${name}.jsonl`);
  const fd = openSync(file, 'w');
  const turns = Math.ceil((mb * 1e6) / 17_000);
  let chunk = '';
  for (let i = 0; i < turns; i++) {
    chunk += turnRows(name, i, end - (turns - 1 - i) * 60_000);
    if (chunk.length > 1 << 20) {
      writeSync(fd, chunk);
      chunk = '';
    }
  }
  writeSync(fd, chunk);
  closeSync(fd);
  return { file, turns };
}

function agent(id, file) {
  db.createAgent({ id, name: id, role: 'developer', machine: MACHINE, harness: 'claude', model: null, effort: null, cwd: home, parent_id: null, session_id: null });
  db.updateAgent(id, { transcript_path: file, activity: 'idle' });
  return db.getAgent(id);
}

// Runs `fn` while sampling the event loop every 5 ms; the longest delay in ms, from perf_hooks'
// histogram and from the longest gap between the sampler's own ticks, whichever is longer. A loop
// held by one long chain of microtasks never runs a sampler, so the wait after `fn` lets it record that.
async function maxDelay(fn) {
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  let last = performance.now();
  let gap = 0;
  const sampler = setInterval(() => {
    const t = performance.now();
    gap = Math.max(gap, t - last - 5);
    last = t;
  }, 5);
  try {
    const out = await fn();
    await new Promise((r) => setTimeout(r, 50));
    return { out, ms: Math.max(h.max / 1e6, gap) };
  } finally {
    clearInterval(sampler);
    h.disable();
  }
}

const now = Date.now();
// One transcript the backfill reads whole, and one longer than its 64 MB tail.
const big = [transcript('big1', 40, now - 60_000), transcript('big2', 80, now - 120_000)];
big.forEach((t, i) => agent(`big${i + 1}`, t.file));
const newest = (i) => `big${i + 1}:big${i + 1}-u${big[i].turns - 1}`;

test('the backfill reads large transcripts without stalling the event loop', async () => {
  T._forget();
  const { out, ms } = await maxDelay(() => T._pending(currentModel(), 100_000));
  console.log(`backfill of 40 MB + 80 MB transcripts: max event-loop delay ${ms.toFixed(0)} ms, ${out.length} turns`);
  assert.ok(ms < MAX_DELAY_MS, `max event-loop delay ${ms.toFixed(0)} ms`);
  assert.ok(out.includes(newest(0)) && out.includes(newest(1)), 'the newest turns are read');
  assert.ok(out.includes('big1:big1-u0'), 'a transcript inside the tail is read whole');
  assert.ok(!out.includes('big2:big2-u0'), 'a transcript longer than the tail is read from the tail');
  assert.equal(cachedTranscripts(), 0, "the backfill leaves the views' parsed transcripts alone");
  assert.ok(
    db.listEvents('big2').some((e) => e.type === 'turn-index-truncated'),
    'the turns it skips are logged',
  );
});

test('a turn end on an uncached transcript indexes its latest turns off the event loop', async () => {
  T._forget();
  appendFileSync(big[1].file, turnRows('big2', 'new', Date.now()));
  const ref = 'big2:big2-unew';
  const { ms } = await maxDelay(async () => {
    T.indexTurnsSoon('big2');
    for (let i = 0; i < 600 && !db.turnSnippet(ref); i++) await new Promise((r) => setTimeout(r, 50));
  });
  console.log(`turn end on an uncached 80 MB transcript: max event-loop delay ${ms.toFixed(0)} ms`);
  assert.ok(db.turnSnippet(ref), 'the new turn is indexed');
  assert.ok(ms < MAX_DELAY_MS, `max event-loop delay ${ms.toFixed(0)} ms`);
});
