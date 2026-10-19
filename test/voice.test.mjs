#!/usr/bin/env node
// Unit tests for voice input (src/voice.ts) against a throwaway STAM_HOME and a stubbed
// ElevenLabs endpoint (STAM_ELEVENLABS_URL), no live daemon, no network. Checks the request
// (key header, model, no diarisation, the clip, keyterms), the text back, the usage row under
// the elevenlabs account, the failure paths (no key, HTTP error), and that the key never shows
// in an event or an error. Run with `node --test test/voice.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempHome } from './tmphome.mjs';

const KEY = 'el-test-key-do-not-leak';
const home = tempHome('stam-voice-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `voice-test-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'ELEVENLABS_API_TOKEN']) delete process.env[k];
const envFile = join(home, 'voice.env');
writeFileSync(envFile, `ELEVENLABS_API_TOKEN=${KEY}\n`, { mode: 0o600 });

// The stub stands in for api.elevenlabs.io: it records each request's headers and form fields
// and answers from `state`.
const state = { status: 200, body: null };
const requests = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    const form = new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw });
    const fd = await form.formData();
    const file = fd.get('file');
    requests.push({
      url: req.url,
      key: req.headers['xi-api-key'],
      model_id: fd.get('model_id'),
      diarize: fd.get('diarize'),
      keyterms: fd.getAll('keyterms'),
      fileType: file?.type,
      fileBytes: file ? Buffer.from(await file.arrayBuffer()) : null,
    });
    if (state.status !== 200) return res.writeHead(state.status).end('{"detail":"stub error"}');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(state.body));
  });
});

let db, voice;
const usageRows = () => db.open().prepare("SELECT * FROM usage WHERE agent_id = 'stam' AND account = 'elevenlabs'").all();
const events = (type) => db.open().prepare('SELECT data FROM events WHERE agent_id = ? AND type = ?').all('stam', type).map((r) => r.data);
const clip = Buffer.from('not really webm, but bytes the stub can see');

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.STAM_ELEVENLABS_URL = `http://127.0.0.1:${server.address().port}`;
  db = await import('../src/db.ts');
  voice = await import('../src/voice.ts');
  db.open();
  // Agent names and an open ITSA key become keyterms.
  db.createAgent({ id: 'a1', name: 'cos', role: '', machine: 'test', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
});
after(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

test('voice is not configured without the key, and no call is made', async () => {
  unlinkSync(envFile);
  assert.equal(voice.configured(), false);
  const before = requests.length;
  await assert.rejects(voice.transcribe(clip, 'audio/webm'), (e) => e instanceof voice.VoiceError && e.status === 503);
  assert.equal(requests.length, before);
  writeFileSync(envFile, `ELEVENLABS_API_TOKEN=${KEY}\n`, { mode: 0o600 });
  assert.equal(voice.configured(), true);
});

test('a clip goes to Scribe with the key, the model, no diarisation, and keyterms; the text comes back', async () => {
  state.status = 200;
  state.body = { text: '  open S-72 for cos  ', audio_duration_secs: 1800, words: [] };
  const out = await voice.transcribe(clip, 'audio/webm;codecs=opus');
  assert.deepEqual(out, { text: 'open S-72 for cos' });
  const r = requests.at(-1);
  assert.equal(r.url, '/v1/speech-to-text');
  assert.equal(r.key, KEY);
  assert.equal(r.model_id, 'scribe_v2');
  assert.equal(r.diarize, 'false');
  assert.ok(r.keyterms.includes('cos'));
  assert.match(r.fileType, /^audio\/webm/);
  assert.deepEqual(r.fileBytes, clip);
});

test('the usage row is the elevenlabs account, attributed to stam, at $0.22 per hour plus keyterms', async () => {
  const rows = usageRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'voice:transcribe');
  // 1800 s is half an hour: $0.11 at $0.22/h, plus the $0.05/h keyterm add-on for the half hour.
  assert.ok(Math.abs(rows[0].cost_usd - 0.5 * 0.27) < 1e-9, String(rows[0].cost_usd));
});

test('an HTTP error answers a clear error, and the key stays out of events and messages', async () => {
  state.status = 500;
  let err;
  await voice.transcribe(clip, 'audio/mp4').catch((e) => (err = e));
  assert.ok(err instanceof voice.VoiceError);
  assert.equal(err.status, 502);
  assert.match(err.message, /HTTP 500/);
  assert.ok(!err.message.includes(KEY));
  assert.equal(events('voice:error').length, 1);
  assert.ok(!events('voice:error')[0].includes(KEY));
  assert.ok(!events('voice:transcribe').join('').includes(KEY));
  state.status = 200;
});

test('an empty clip and an oversized clip are refused without a call', async () => {
  const before = requests.length;
  await assert.rejects(voice.transcribe(Buffer.alloc(0), 'audio/webm'), (e) => e.status === 400);
  await assert.rejects(voice.transcribe(Buffer.alloc(voice.MAX_BYTES + 1), 'audio/webm'), (e) => e.status === 413);
  assert.equal(requests.length, before);
});

test('a voice.env that is not mode 600 turns voice off, and the event says only why', async () => {
  chmodSync(envFile, 0o644);
  try {
    assert.equal(voice.configured(), false);
    await assert.rejects(voice.transcribe(clip, 'audio/webm'), (e) => e instanceof voice.VoiceError && e.status === 503);
    const errs = events('voice:error').map(String);
    assert.ok(errs.some((d) => d.includes('voice.env must be mode 600')), 'the event names the mode');
    assert.ok(errs.every((d) => !d.includes(KEY)), 'the key stays out of the event');
  } finally {
    chmodSync(envFile, 0o600);
  }
  assert.equal(voice.configured(), true);
});
